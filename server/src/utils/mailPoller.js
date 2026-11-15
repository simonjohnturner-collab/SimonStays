/**
 * Zoho IMAP poller — reads Airbnb reservation emails from a dedicated folder and
 * fills guest names onto bookings (Airbnb's iCal has the code but not the name).
 * Reads ONLY the configured folder; marks messages seen so they aren't reprocessed.
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const prisma = require('../lib/prisma');
const { parseAirbnbEmail } = require('./guestEmail');
const { applyGuestNames } = require('./sync');
const { isReviewEmail, parseAirbnbReview, saveAirbnbReview } = require('./airbnbReviews');

function config() {
  return {
    host: process.env.ZOHO_IMAP_HOST || 'imap.zoho.com',
    port: Number(process.env.ZOHO_IMAP_PORT) || 993,
    user: process.env.ZOHO_IMAP_USER,
    pass: process.env.ZOHO_IMAP_PASSWORD,
    folder: process.env.ZOHO_IMAP_FOLDER || 'Inbox/Airbnb',
    hostEmail: process.env.ZOHO_IMAP_HOST_EMAIL || 'demo@staysync.local',
  };
}

let reviewsBackfilled = false;

function enabled() { const c = config(); return !!(c.user && c.pass); }

async function pollOnce() {
  const c = config();
  if (!c.user || !c.pass) return { skipped: 'not_configured' };
  const host = await prisma.host.findUnique({ where: { email: c.hostEmail } });
  if (!host) {
    console.warn(`[mailPoller] host_not_found for ZOHO_IMAP_HOST_EMAIL="${c.hostEmail}" — nothing will be matched. Set it to your host account email.`);
    return { error: 'host_not_found', hostEmail: c.hostEmail };
  }

  const client = new ImapFlow({ host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  await client.connect();
  const summary = { processed: 0, matched: 0, updated: 0, failed: 0, reviews: 0, details: [] };
  try {
    const lock = await client.getMailboxLock(c.folder);
    try {
      // Look back over recent messages regardless of read/unread. Previously we
      // only fetched UNSEEN mail, so if a host opened the Airbnb email in Zoho
      // before the poll ran, it was marked seen and skipped — the name never
      // landed. applyGuestNames only fills placeholder names (never clobbers a
      // hand-typed one) and the lookup upsert is idempotent, so reprocessing a
      // recent window is safe.
      const since = new Date(Date.now() - 21 * 864e5);
      const uids = await client.search({ since }, { uid: true });
      for (const uid of uids || []) {
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          const parsed = await simpleParser(msg.source);
          // Feed BOTH the plaintext and the HTML: Airbnb puts the reservation
          // code in a link href (…/reservations/details/HM…), which the plaintext
          // part strips out — so without the HTML the code was never found and
          // the whole email (name included) was discarded.
          const body = [parsed.text, parsed.html].filter(Boolean).join('\n');
          const { resCode, guestName, phoneLast4 } = parseAirbnbEmail({ subject: parsed.subject || '', body });
          summary.processed++;
          // A published Airbnb review: keep it for the shopfront's ratings.
          if (isReviewEmail(parsed.subject)) {
            const review = parseAirbnbReview({ subject: parsed.subject || '', text: parsed.text || '', html: parsed.html || '', messageId: parsed.messageId, date: parsed.date });
            if (review && (await saveAirbnbReview(host.id, review)) !== 'unchanged') summary.reviews++;
          }
          let applied = 0;
          if (resCode && guestName) {
            await prisma.guestLookup.upsert({
              where: { hostId_resCode: { hostId: host.id, resCode } },
              // The phone's last 4 digits let the guestbook confirm it's really them.
              update: { guestName, ...(phoneLast4 ? { phoneLast4 } : {}) },
              create: { hostId: host.id, resCode, guestName, phoneLast4: phoneLast4 || null },
            });
            summary.matched++;
            applied = await applyGuestNames(host.id, resCode);
            summary.updated += applied;
          }
          // Per-email diagnostics so a poll makes the failure mode obvious in the
          // Render logs: did we find a code? a name? did it back-fill a booking?
          if (summary.details.length < 30) summary.details.push({ subject: (parsed.subject || '').slice(0, 90), resCode: resCode || null, guestName: guestName || null, applied });
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (e) { summary.failed++; }
      }
      // Once per server start: read every published review in the folder, not
      // just the last three weeks, so the shopfront has the full history and
      // older unmatched reviews get another chance to match a booking.
      if (!reviewsBackfilled) {
        reviewsBackfilled = true;
        const all = await client.search({ subject: 'review' }, { uid: true });
        for (const uid of all || []) {
          try {
            const msg = await client.fetchOne(uid, { envelope: true }, { uid: true });
            if (!isReviewEmail(msg.envelope && msg.envelope.subject)) continue;
            const full = await client.fetchOne(uid, { source: true }, { uid: true });
            const parsed = await simpleParser(full.source);
            const review = parseAirbnbReview({ subject: parsed.subject || '', text: parsed.text || '', html: parsed.html || '', messageId: parsed.messageId, date: parsed.date });
            if (review && (await saveAirbnbReview(host.id, review)) !== 'unchanged') summary.reviews++;
          } catch (e) { summary.failed++; }
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  console.log('[mailPoller] poll result:', JSON.stringify({ processed: summary.processed, reviews: summary.reviews, matched: summary.matched, updated: summary.updated, failed: summary.failed, details: summary.details }));
  return summary;
}

module.exports = { pollOnce, enabled, config };
