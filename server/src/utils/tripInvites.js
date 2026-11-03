// Sharing a trip with a friend. The booker or host makes a link; whoever signs in
// with it joins the trip and can read and send its messages. A link works once
// and only its hash is stored, because a trip shows its door code.
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { isBooker } = require('./guestAccess');

const INVITE_DAYS = 14;
const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

async function createInvite(bookingId, createdBy) {
  const token = crypto.randomBytes(24).toString('hex');
  await prisma.tripInvite.create({ data: { bookingId, tokenHash: hashOf(token), createdBy, expiresAt: new Date(Date.now() + INVITE_DAYS * 864e5) } });
  const base = (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
  return { link: `${base}/?invite=${token}`, days: INVITE_DAYS };
}

// Join this account to the invite's trip. Returns { bookingId }, or { error, status, message }.
async function acceptInvite(token, acct) {
  const invite = await prisma.tripInvite.findUnique({
    where: { tokenHash: hashOf(token) },
    include: { booking: { select: { id: true, hostId: true, status: true, guestAccountId: true, guestEmail: true, unit: { select: { property: { select: { hostId: true } } } } } } },
  });
  const gone = { error: 'invite_invalid', status: 410, message: 'This invite has expired or has already been used. Please ask for a new one.' };
  if (!invite || invite.usedAt || invite.expiresAt < new Date() || invite.booking.status === 'cancelled') return gone;
  const b = invite.booking;
  // The booker opening their own link leaves it for the friend it was meant for.
  if (isBooker(b, acct)) return { bookingId: b.id };
  const claimed = await prisma.tripInvite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: new Date(), usedByAccountId: acct.id } });
  if (!claimed.count) return gone;
  const already = await prisma.tripGuest.findUnique({ where: { bookingId_guestAccountId: { bookingId: b.id, guestAccountId: acct.id } } });
  if (already) return { bookingId: b.id };
  await prisma.tripGuest.create({ data: { bookingId: b.id, guestAccountId: acct.id } });
  const name = acct.name || acct.email;
  await prisma.message.create({ data: { hostId: b.hostId || b.unit.property.hostId, bookingId: b.id, sender: 'guest', authorId: acct.id, authorName: name, body: `${name} has joined this trip.` } });
  return { bookingId: b.id };
}

const tripGuestsOf = (bookingId) => prisma.tripGuest.findMany({
  where: { bookingId }, orderBy: { createdAt: 'asc' },
  select: { account: { select: { id: true, name: true, email: true } } },
}).then((rows) => rows.map((r) => r.account));

module.exports = { createInvite, acceptInvite, tripGuestsOf };
