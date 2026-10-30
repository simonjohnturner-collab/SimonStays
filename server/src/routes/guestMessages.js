// Guest side of messaging on the shopfront: a signed-in guest reads the host's
// messages about their trips and can reply. Ownership matches "my trips": a
// booking linked to the account, or made with the account's email.
const express = require('express');
const prisma = require('../lib/prisma');
const { authGuest } = require('../middleware/auth');

const router = express.Router();
router.use(authGuest);

const iso = (d) => new Date(d).toISOString().slice(0, 10);

async function accountOf(req, res) {
  const acct = await prisma.guestAccount.findUnique({ where: { id: req.guestId } });
  if (!acct) res.status(404).json({ error: 'not_found' });
  return acct;
}
const mine = (acct) => ({ OR: [{ guestAccountId: acct.id }, { guestEmail: { equals: acct.email, mode: 'insensitive' } }] });

const msgOut = (m) => ({ id: m.id, sender: m.sender, body: m.body, createdAt: m.createdAt, readAt: m.readAt });

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
      include: { unit: { include: { property: true } }, messages: { orderBy: { createdAt: 'asc' } } },
    });
    const threads = bookings.map((b) => ({
      bookingId: b.id, ref: b.ref || null, status: b.status,
      propertyName: b.unit?.property?.name || null, unitName: b.unit?.name || null,
      checkIn: iso(b.checkIn), checkOut: iso(b.checkOut),
      messages: b.messages.map(msgOut),
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
    res.status(201).json({ message: msgOut(m) });
  } catch (e) { next(e); }
});

module.exports = router;
