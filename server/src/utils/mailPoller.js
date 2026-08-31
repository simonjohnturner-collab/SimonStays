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

function enabled() { const c = config(); return !!(c.user && c.pass); }

async function pollOnce() {
  const c = config();
  if (!c.user || !c.pass) return { skipped: 'not_configured' };
  const host = await prisma.host.findUnique({ where: { email: c.hostEmail } });
  if (!host) return { error: 'host_not_found', hostEmail: c.hostEmail };

  const client = new ImapFlow({ host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  await client.connect();
  const summary = { processed: 0, matched: 0, updated: 0, failed: 0 };
  try {
    const lock = await client.getMailboxLock(c.folder);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids || []) {
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          const parsed = await simpleParser(msg.source);
          const { resCode, guestName } = parseAirbnbEmail({ subject: parsed.subject || '', body: parsed.text || parsed.html || '' });
          summary.processed++;
          if (resCode && guestName) {
            await prisma.guestLookup.upsert({
              where: { hostId_resCode: { hostId: host.id, resCode } },
              update: { guestName },
              create: { hostId: host.id, resCode, guestName },
            });
            summary.matched++;
            summary.updated += await applyGuestNames(host.id, resCode);
          }
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (e) { summary.failed++; }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  return summary;
}

module.exports = { pollOnce, enabled, config };
