// One-time, idempotent backfill: older website bookings stored the guest's email
// and phone only inside the free-text `comments` ("… · Contact: <email> · <phone>
// · Guests: …"). To let guests see their previous trips, lift that contact into
// the new structured Booking.guestEmail / guestPhone columns. Runs on startup;
// only touches website bookings whose guestEmail is still null, so it is safe to
// run repeatedly and never overwrites data captured the new way.

const prisma = require('../lib/prisma');

// Pull the "Contact: … · Guests:" segment out of a comments string and split it
// into an email (first token containing '@') and a phone (first mostly-digit token).
function parseContact(comments) {
  if (!comments) return { email: null, phone: null };
  const m = /Contact:\s*(.*?)(?:\s·\sGuests:|$)/s.exec(comments);
  if (!m) return { email: null, phone: null };
  const tokens = m[1].split('·').map((t) => t.trim()).filter(Boolean);
  let email = null, phone = null;
  for (const t of tokens) {
    if (!email && t.includes('@') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) email = t.toLowerCase();
    else if (!phone && /\d/.test(t) && !t.includes('@')) phone = t;
  }
  return { email, phone };
}

async function backfillGuestContacts() {
  const rows = await prisma.booking.findMany({
    where: { source: 'website', guestEmail: null },
    select: { id: true, comments: true },
  });
  let filled = 0;
  for (const b of rows) {
    const { email, phone } = parseContact(b.comments);
    if (!email && !phone) continue;
    await prisma.booking.update({ where: { id: b.id }, data: { guestEmail: email, guestPhone: phone } });
    filled++;
  }
  // Now that emails exist, link them to any accounts that already registered.
  const accounts = await prisma.guestAccount.findMany({ select: { id: true, email: true } });
  let linked = 0;
  for (const a of accounts) {
    const r = await prisma.booking.updateMany({
      where: { guestAccountId: null, guestEmail: { equals: a.email, mode: 'insensitive' } },
      data: { guestAccountId: a.id },
    });
    linked += r.count;
  }
  if (filled || linked) console.log(`[guestBackfill] filled contacts on ${filled} booking(s); linked ${linked} to accounts`);
  return { filled, linked };
}

module.exports = { backfillGuestContacts, parseContact };
