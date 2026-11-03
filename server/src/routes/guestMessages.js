// Guest side of messaging on the shopfront: a signed-in guest reads the host's
// messages about their trips and can reply. Ownership matches "my trips": a
// booking linked to the account, or made with the account's email.
const express = require('express');
const prisma = require('../lib/prisma');
const { authGuest } = require('../middleware/auth');
const { checkAvailability } = require('../utils/sync');
const { dateOnly, shownCheckOut, shownNights } = require('../utils/ical');
const { quote } = require('../utils/pricing');
const { overridesFor } = require('../utils/nightPrices');
const { alertHost } = require('../utils/payments');
const { offerOut, conversationCents, INVOICEABLE_SOURCES } = require('../utils/offers');
const changes = require('../utils/changes');
const { nextRef } = require('../utils/bookingRef');
const { createInvite, acceptInvite } = require('../utils/tripInvites');
const { ownTrips, onTrip, isBooker } = require('../utils/guestAccess');

// What this conversation costs: its invoices, else the booking.
function amountOf(b) {
  const invoiced = conversationCents(b.messages.filter((m) => m.offer).map((m) => m.offer));
  if (invoiced != null) return invoiced;
  return b.quotedCents != null ? b.quotedCents : (b.totalCents != null ? b.totalCents : null);
}

const router = express.Router();
router.use(authGuest);

const iso = (d) => new Date(d).toISOString().slice(0, 10);

async function accountOf(req, res) {
  const acct = await prisma.guestAccount.findUnique({ where: { id: req.guestId } });
  if (!acct) res.status(404).json({ error: 'not_found' });
  return acct;
}

// A friend on the trip reads the conversation but nothing about money: what the
// booker paid is theirs, so invoices, refunds and proof of payment stay with them.
const seenByFriends = (m) => !m.bookerOnly && !m.offerId;
const msgOut = (m, b, acct) => ({
  id: m.id, sender: m.sender, body: m.unsentAt ? '' : m.body, unsent: !!m.unsentAt, createdAt: m.createdAt, readAt: m.readAt,
  authorName: m.authorName || null, mine: m.sender === 'guest' && (m.authorId ? m.authorId === acct.id : isBooker(b, acct)),
  offer: m.offer ? offerOut(m.offer, b) : null,
});
const MAX_OPEN_ENQUIRIES = 10;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// GET /public/account/messages — one thread per trip that has messages or is
// still upcoming (so the guest can start one), newest activity first.
router.get('/', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const bookings = await prisma.booking.findMany({
      where: {
        unitId: { not: null },
        AND: [onTrip(acct), { OR: [
          { messages: { some: {} } },
          { status: { in: ['confirmed', 'pending'] }, checkOut: { gte: today } },
        ] }],
      },
      include: {
        unit: { include: { property: true } }, messages: { orderBy: { createdAt: 'asc' }, include: { offer: true } },
        tripGuests: { orderBy: { createdAt: 'asc' }, select: { account: { select: { id: true, name: true, email: true } } } },
      },
    });
    const threads = bookings.map((b) => {
      const booker = isBooker(b, acct);
      const seen = booker ? b.messages : b.messages.filter(seenByFriends);
      return {
      bookingId: b.id, ref: b.ref || null, status: b.status, isBooker: booker,
      // Friends' email addresses are only for the booker, who invited them.
      people: b.tripGuests.map(({ account: a }) => ({ id: a.id, name: a.name || (booker ? a.email : 'Guest'), me: a.id === acct.id })),
      propertyName: b.unit?.property?.name || null, unitName: b.unit?.name || null,
      guestName: b.guestName || acct.name || null,
      checkIn: iso(b.checkIn), checkOut: iso(shownCheckOut(b)),
      nights: shownNights(b), dayUse: !!b.dayUse,
      amountCents: booker ? amountOf(b) : null,
      canRequest: booker && b.status === 'confirmed' && INVOICEABLE_SOURCES.includes(b.source),
      refundDueCents: booker ? b.refundDueCents : null, refundedAt: booker ? b.refundedAt : null,
      messages: seen.map((m) => msgOut(m, b, acct)),
      unread: seen.filter((m) => m.sender === 'host' && !m.readAt && !m.unsentAt).length,
      };
    });
    const lastAt = (t) => (t.messages.length ? new Date(t.messages[t.messages.length - 1].createdAt).getTime() : 0);
    threads.sort((a, b) => lastAt(b) - lastAt(a) || (a.checkIn < b.checkIn ? -1 : 1));
    res.json({ threads, unread: threads.reduce((n, t) => n + t.unread, 0), emailVerified: !!acct.emailVerifiedAt });
  } catch (e) { next(e); }
});

// GET /public/account/messages/unread — for the header badge.
router.get('/unread', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const count = await prisma.message.count({ where: { sender: 'host', readAt: null, unsentAt: null, OR: [{ booking: ownTrips(acct) }, { bookerOnly: false, offerId: null, booking: onTrip(acct) }] } });
    res.json({ count });
  } catch (e) { next(e); }
});

// POST /public/account/messages/invites/accept { token } — join a trip from an invite link.
router.post('/invites/accept', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const r = await acceptInvite((req.body || {}).token, acct);
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    res.json({ bookingId: r.bookingId });
  } catch (e) { next(e); }
});

// POST /public/account/messages/enquiry { unitId, checkIn, checkOut, guests, body }
// Ask the host about a stay before booking. Holds no dates. The same guest asking
// about the same unit and dates again continues their existing conversation.
router.post('/enquiry', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    // They couldn't read the reply, and the reply goes to an address nobody has proved.
    if (!acct.emailVerifiedAt) return res.status(403).json({ error: 'email_unverified', message: 'Please confirm your email first, using the link we sent you. You can send it again from My trips.' });
    const { unitId, checkIn, checkOut, guests } = req.body || {};
    const text = String((req.body || {}).body || '').trim().slice(0, 4000);
    if (!unitId || !YMD.test(checkIn || '') || !YMD.test(checkOut || '')) return res.status(400).json({ error: 'unitId_dates_required', message: 'Please choose your dates first.' });
    if (!text) return res.status(400).json({ error: 'empty', message: 'Type a message first.' });
    if (checkOut <= checkIn || checkIn < iso(new Date())) return res.status(400).json({ error: 'invalid_dates', message: 'Please choose valid future dates.' });
    const unit = await prisma.unit.findUnique({ where: { id: String(unitId) }, include: { pricingGroup: true, property: true } });
    if (!unit) return res.status(404).json({ error: 'not_found' });
    const avail = await checkAvailability(unit.id, checkIn, checkOut, null);
    if (avail.error || !avail.available) return res.status(409).json({ error: 'dates_unavailable', message: 'Sorry, those dates are not available. Please choose different dates.' });

    const hostId = unit.property.hostId;
    const send = (bookingId) => prisma.message.create({ data: { hostId, bookingId, sender: 'guest', body: text } });
    const existing = await prisma.booking.findFirst({
      where: { unitId: unit.id, status: 'enquiry', guestAccountId: acct.id, checkIn: dateOnly(checkIn), checkOut: dateOnly(checkOut) },
    });
    if (existing) { await send(existing.id); return res.status(201).json({ bookingId: existing.id }); }
    const open = await prisma.booking.count({ where: { guestAccountId: acct.id, status: 'enquiry', checkOut: { gte: new Date() } } });
    if (open >= MAX_OPEN_ENQUIRIES) return res.status(429).json({ error: 'too_many', message: 'You have several open enquiries. Please continue one of those in Messages.' });

    const q = unit.pricingGroup
      ? quote(unit.pricingGroup, { checkIn, checkOut, cleans: 1, overrides: await overridesFor(unit.id, checkIn, checkOut) })
      : null;
    const ref = await nextRef();
    const count = Number(guests) > 0 ? ` · Guests: ${Math.floor(Number(guests))}` : '';
    const booking = await prisma.booking.create({
      data: {
        unitId: unit.id, hostId, source: 'website', status: 'enquiry', ref,
        guestName: acct.name || acct.email, guestEmail: acct.email, guestPhone: acct.phone || null, guestAccountId: acct.id,
        checkIn: dateOnly(checkIn), checkOut: dateOnly(checkOut), paymentStatus: 'unpaid',
        totalCents: q ? q.totalCents : null, depositCents: q && q.depositCents ? q.depositCents : null,
        comments: `Enquiry ${ref}${count}`,
      },
    });
    await send(booking.id);
    const place = [unit.property.name, unit.name && `Unit ${unit.name}`].filter(Boolean).join(' · ');
    alertHost(booking, `💬 New enquiry: ${place}\n👤 ${booking.guestName}${count}\n📅 ${checkIn} → ${checkOut}${q ? `\nStandard price R${(q.totalCents / 100).toFixed(2)}` : ''}\n\n${text.slice(0, 300)}`);
    res.status(201).json({ bookingId: booking.id, ref });
  } catch (e) { next(e); }
});

async function ownedBooking(req, res, acct, { bookerOnly = false } = {}) {
  const b = await prisma.booking.findFirst({ where: { id: req.params.bookingId, ...(bookerOnly ? ownTrips(acct) : onTrip(acct)) }, include: { unit: { include: { property: true } } } });
  if (!b) res.status(404).json({ error: 'not_found' });
  return b;
}

// POST /public/account/messages/:bookingId/read — mark the host's messages read.
router.post('/:bookingId/read', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const b = await ownedBooking(req, res, acct); if (!b) return;
    await prisma.message.updateMany({ where: { bookingId: b.id, sender: 'host', readAt: null, ...(isBooker(b, acct) ? {} : { bookerOnly: false, offerId: null }) }, data: { readAt: new Date() } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /public/account/messages/:bookingId/cancel — what cancelling would refund.
router.get('/:bookingId/cancel', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const b = await ownedBooking(req, res, acct, { bookerOnly: true }); if (!b) return;
    res.json(await changes.cancelQuote(b, 'guest'));
  } catch (e) { next(e); }
});

// POST /public/account/messages/:bookingId/cancel — the guest cancels; the refund follows the policy.
router.post('/:bookingId/cancel', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const b = await ownedBooking(req, res, acct, { bookerOnly: true }); if (!b) return;
    const r = await changes.cancelBooking(b, { by: 'guest' });
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    res.json({ ok: true, refundCents: r.refundCents });
  } catch (e) { next(e); }
});

// POST /public/account/messages/:bookingId/invite — the booker makes a link for a friend.
router.post('/:bookingId/invite', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const b = await ownedBooking(req, res, acct, { bookerOnly: true }); if (!b) return;
    if (b.status === 'cancelled') return res.status(400).json({ error: 'cancelled', message: 'This booking has been cancelled.' });
    res.status(201).json(await createInvite(b.id, 'guest'));
  } catch (e) { next(e); }
});

// DELETE /public/account/messages/:bookingId/people/:accountId — the booker removes
// a friend, or a friend takes themselves off the trip.
router.delete('/:bookingId/people/:accountId', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const b = await ownedBooking(req, res, acct); if (!b) return;
    if (!isBooker(b, acct) && req.params.accountId !== acct.id) return res.status(403).json({ error: 'forbidden' });
    await prisma.tripGuest.deleteMany({ where: { bookingId: b.id, guestAccountId: req.params.accountId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /public/account/messages/:bookingId { body } — the guest replies.
router.post('/:bookingId', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const b = await ownedBooking(req, res, acct); if (!b) return;
    const body = String((req.body || {}).body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'empty', message: 'Type a message first.' });
    const hostId = b.hostId || (b.unit && b.unit.property.hostId);
    const m = await prisma.message.create({ data: { hostId, bookingId: b.id, sender: 'guest', authorId: acct.id, authorName: acct.name || acct.email, body } });
    if (b.status === 'enquiry' || (req.body || {}).request) alertHost(b, `💬 ${b.status === 'enquiry' ? 'Enquiry reply' : 'Booking request'} from ${b.guestName || 'guest'}${b.ref ? ` (${b.ref})` : ''}\n\n${body.slice(0, 300)}`);
    res.status(201).json({ message: msgOut(m, b, acct) });
  } catch (e) { next(e); }
});

module.exports = router;
