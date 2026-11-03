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
const { offerOut } = require('../utils/offers');

// What this conversation costs: the paid invoice, else the latest, else the booking.
function amountOf(b) {
  const sent = b.messages.filter((m) => m.offer).map((m) => m.offer);
  const o = sent.find((x) => x.status === 'paid') || sent[sent.length - 1];
  if (o) return o.totalCents;
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
const mine = (acct) => ({ OR: [{ guestAccountId: acct.id }, { guestEmail: { equals: acct.email, mode: 'insensitive' } }] });

const msgOut = (m, b) => ({ id: m.id, sender: m.sender, body: m.body, createdAt: m.createdAt, readAt: m.readAt, offer: m.offer ? offerOut(m.offer, b) : null });
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
        AND: [mine(acct), { OR: [
          { messages: { some: {} } },
          { status: { in: ['confirmed', 'pending'] }, checkOut: { gte: today } },
        ] }],
      },
      include: { unit: { include: { property: true } }, messages: { orderBy: { createdAt: 'asc' }, include: { offer: true } } },
    });
    const threads = bookings.map((b) => ({
      bookingId: b.id, ref: b.ref || null, status: b.status,
      propertyName: b.unit?.property?.name || null, unitName: b.unit?.name || null,
      guestName: b.guestName || acct.name || null,
      checkIn: iso(b.checkIn), checkOut: iso(shownCheckOut(b)),
      nights: shownNights(b), dayUse: !!b.dayUse,
      amountCents: amountOf(b),
      messages: b.messages.map((m) => msgOut(m, b)),
      unread: b.messages.filter((m) => m.sender === 'host' && !m.readAt).length,
    }));
    const lastAt = (t) => (t.messages.length ? new Date(t.messages[t.messages.length - 1].createdAt).getTime() : 0);
    threads.sort((a, b) => lastAt(b) - lastAt(a) || (a.checkIn < b.checkIn ? -1 : 1));
    res.json({ threads, unread: threads.reduce((n, t) => n + t.unread, 0) });
  } catch (e) { next(e); }
});

// GET /public/account/messages/unread — for the header badge.
router.get('/unread', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const count = await prisma.message.count({ where: { sender: 'host', readAt: null, booking: mine(acct) } });
    res.json({ count });
  } catch (e) { next(e); }
});

// POST /public/account/messages/enquiry { unitId, checkIn, checkOut, guests, body }
// Ask the host about a stay before booking. Holds no dates. The same guest asking
// about the same unit and dates again continues their existing conversation.
router.post('/enquiry', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
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
    const seq = (await prisma.booking.count({ where: { hostId, source: 'website' } })) + 1;
    const ref = 'SS' + String(1000 + seq);
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

async function ownedBooking(req, res, acct) {
  const b = await prisma.booking.findFirst({ where: { id: req.params.bookingId, ...mine(acct) }, include: { unit: { include: { property: true } } } });
  if (!b) res.status(404).json({ error: 'not_found' });
  return b;
}

// POST /public/account/messages/:bookingId/read — mark the host's messages read.
router.post('/:bookingId/read', async (req, res, next) => {
  try {
    const acct = await accountOf(req, res); if (!acct) return;
    const b = await ownedBooking(req, res, acct); if (!b) return;
    await prisma.message.updateMany({ where: { bookingId: b.id, sender: 'host', readAt: null }, data: { readAt: new Date() } });
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
    const m = await prisma.message.create({ data: { hostId, bookingId: b.id, sender: 'guest', body } });
    if (b.status === 'enquiry') alertHost(b, `💬 Enquiry reply from ${b.guestName || 'guest'}${b.ref ? ` (${b.ref})` : ''}\n\n${body.slice(0, 300)}`);
    res.status(201).json({ message: msgOut(m, b) });
  } catch (e) { next(e); }
});

module.exports = router;
