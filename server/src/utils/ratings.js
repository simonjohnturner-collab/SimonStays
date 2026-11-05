// Ratings after a stay: the guest rates the host, and the host rates the guest.
const prisma = require('../lib/prisma');
const messaging = require('./messaging');
const { rateLink } = require('./guestThread');
const { shownCheckOut } = require('./ical');

const HOST_CATEGORIES = [
  { key: 'cleanliness', label: 'Cleanliness' },
  { key: 'accuracy', label: 'Accuracy' },
  { key: 'engagement', label: 'Engagement' },
  { key: 'value', label: 'Value for money' },
];
const GUEST_CATEGORIES = [
  { key: 'communication', label: 'Communication' },
  { key: 'cleanliness', label: 'Cleanliness' },
  { key: 'rules', label: 'Following the property rules' },
];
const categoriesOf = (kind) => (kind === 'host' ? HOST_CATEGORIES : GUEST_CATEGORIES);

const SAST_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 864e5;
const INVITE_CATCH_UP_MS = 3 * DAY_MS; // the server may have been asleep; older than this isn't invited
const RATING_WINDOW_MS = 30 * DAY_MS;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const round1 = (n) => Math.round(n * 10) / 10;

const guestEmailOf = (b) => String(b.guestEmail || (b.guestAccount && b.guestAccount.email) || '').trim().toLowerCase() || null;
const hostOf = (b) => b.hostId || (b.unit && b.unit.property ? b.unit.property.hostId : null);

// Ratings as an overall figure and one per category, or null if there are none.
function summarise(rows, kind) {
  if (!rows.length) return null;
  const mean = (xs) => xs.reduce((n, x) => n + x, 0) / xs.length;
  return {
    average: round1(mean(rows.map((r) => r.average))),
    count: rows.length,
    categories: categoriesOf(kind).map((c) => {
      const given = rows.map((r) => Number(r.scores && r.scores[c.key])).filter((v) => v >= 1);
      return { key: c.key, label: c.label, average: given.length ? round1(mean(given)) : 0 };
    }),
  };
}

const allOf = (where, kind) => prisma.rating.findMany({ where: { kind, ...where }, select: { scores: true, average: true } });
const guestRatingOf = async (email) => (email ? summarise(await allOf({ guestEmail: email }, 'guest'), 'guest') : null);
const propertyRatingOf = async (propertyId) => summarise(await allOf({ propertyId }, 'host'), 'host');
const hostRatingOf = async (hostId) => summarise(await allOf({ hostId }, 'host'), 'host');

// propertyId -> { average, count }, for the shopfront's listings.
async function ratingsByProperty() {
  const rows = await prisma.rating.groupBy({ by: ['propertyId'], where: { kind: 'host' }, _avg: { average: true }, _count: true });
  return Object.fromEntries(rows.map((r) => [r.propertyId, { average: round1(r._avg.average), count: r._count }]));
}

// Check a set of scores: every category, whole stars from 1 to 5.
function cleanScores(kind, raw) {
  const scores = {};
  for (const c of categoriesOf(kind)) {
    const v = Number(raw && raw[c.key]);
    if (!Number.isInteger(v) || v < 1 || v > 5) return null;
    scores[c.key] = v;
  }
  return scores;
}

// Why this booking can't be rated yet (or any more), or null if it can.
function ratingBlock(b, now = Date.now()) {
  if (b.status !== 'confirmed' || !b.unitId) return 'Only a confirmed stay can be rated.';
  if (!['website', 'manual'].includes(b.source)) return 'Only direct bookings can be rated. Channels like Airbnb run their own ratings.';
  if (!guestEmailOf(b)) return 'This booking has no guest email, so there’s nobody to attach a rating to.';
  const out = new Date(shownCheckOut(b)).getTime();
  if (now < out) return 'A stay can be rated once it’s over.';
  if (now > out + RATING_WINDOW_MS) return 'Ratings close 30 days after checkout.';
  return null;
}

// Save a rating. `b` needs its unit and property. Answers { rating } or { error, status, message }.
async function saveRating(b, kind, rawScores) {
  const blocked = ratingBlock(b);
  if (blocked) return { error: 'not_ratable', status: 400, message: blocked };
  const scores = cleanScores(kind, rawScores);
  if (!scores) return { error: 'bad_scores', status: 400, message: 'Please choose 1 to 5 stars for each one.' };
  const values = Object.values(scores);
  try {
    const rating = await prisma.rating.create({
      data: {
        bookingId: b.id, kind, hostId: hostOf(b), propertyId: b.unit.propertyId, guestEmail: guestEmailOf(b),
        scores, average: values.reduce((n, v) => n + v, 0) / values.length,
      },
    });
    return { rating };
  } catch (e) {
    if (e.code === 'P2002') return { error: 'already_rated', status: 409, message: 'This stay has already been rated.' };
    throw e;
  }
}

// When a guest is invited to rate: 10:00 SAST the day after checkout.
function inviteDueAt(b) {
  const [y, m, d] = iso(shownCheckOut(b)).split('-').map(Number);
  return Date.UTC(y, m - 1, d + 1, 10) - SAST_MS;
}

// A guest still staying in another booking is asked once that stay is ending: at
// 10:00 SAST on the day it ends, rather than being asked to rate mid-stay.
async function inviteDueFor(b, email) {
  const due = inviteDueAt(b);
  const others = await prisma.booking.findMany({
    where: {
      id: { not: b.id }, status: 'confirmed', source: { in: ['website', 'manual'] },
      guestEmail: { equals: email, mode: 'insensitive' },
      checkIn: { lte: new Date(due) }, checkOut: { gt: new Date(due) },
    },
    select: { checkIn: true, checkOut: true, dayUse: true, leavingEarly: true },
  });
  return others.reduce((latest, o) => {
    const [y, m, d] = iso(shownCheckOut(o)).split('-').map(Number);
    return Math.max(latest, Date.UTC(y, m - 1, d, 10) - SAST_MS);
  }, due);
}

function inviteEmail(place, link) {
  const text = `How was your stay at ${place}? Please rate it here: ${link}`;
  return {
    subject: `How was your stay at ${place}?`,
    text: `Thank you for staying with SimonStays.\n\n${text}\n\nIt only takes a minute.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#1d2433">` +
      `<p>Thank you for staying with SimonStays.</p><p>How was your stay at <b>${String(place).replace(/[&<>"]/g, '')}</b>? Your rating helps other guests choose, and it only takes a minute.</p>` +
      `<p><a href="${link}" style="display:inline-block;background:#1a7a3a;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Rate your stay</a></p></div>`,
  };
}

// Invite guests whose stay has ended. Each booking is invited once.
async function runRatingInvites(now = new Date()) {
  const bookings = await prisma.booking.findMany({
    where: {
      status: 'confirmed', source: { in: ['website', 'manual'] }, unitId: { not: null }, ratingInviteAt: null,
      checkOut: { gte: new Date(now.getTime() - RATING_WINDOW_MS), lte: now }, // an invitation can wait for a longer stay
      OR: [{ guestEmail: { not: null } }, { guestAccountId: { not: null } }],
    },
    include: { ...messaging.BOOKING_INCLUDE, guestAccount: { select: { email: true } } },
  });
  let sent = 0;
  for (const b of bookings) {
    const email = guestEmailOf(b);
    if (!email || now.getTime() < inviteDueAt(b)) continue;
    const due = await inviteDueFor(b, email);
    if (now.getTime() < due || now.getTime() - due > INVITE_CATCH_UP_MS) continue;
    const claimed = await prisma.booking.updateMany({ where: { id: b.id, ratingInviteAt: null }, data: { ratingInviteAt: now } });
    if (!claimed.count) continue;
    const place = [b.unit?.property?.name, b.unit?.name && `Unit ${b.unit.name}`].filter(Boolean).join(' · ') || 'SimonStays';
    const link = rateLink(b.id);
    await messaging.sendHostMessage(b.id, `How was your stay at ${place}? Please rate it here: ${link}`, { bookerOnly: true, email: inviteEmail(place, link) })
      .then(() => { sent++; })
      .catch((e) => console.error('[ratings] invite failed', b.id, e.message));
  }
  return { sent };
}

module.exports = {
  HOST_CATEGORIES, GUEST_CATEGORIES, categoriesOf, guestEmailOf, summarise, guestRatingOf, propertyRatingOf, hostRatingOf,
  ratingsByProperty, ratingBlock, saveRating, runRatingInvites, inviteDueAt, RATING_WINDOW_MS,
};
