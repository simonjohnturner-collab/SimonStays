// The guest's side of a conversation, opened from the private link in their email.
// They're the guest who booked, so they see everything but anything unsent.
const express = require('express');
const prisma = require('../lib/prisma');
const { bookingIdOf, linkExpired } = require('../utils/guestThread');
const { offerOut } = require('../utils/offers');
const { shownCheckOut } = require('../utils/ical');

const router = express.Router();
const iso = (d) => new Date(d).toISOString().slice(0, 10);

async function bookingOf(req, res, include = {}) {
  const id = bookingIdOf(req.params.token);
  const b = id && await prisma.booking.findUnique({ where: { id }, include: { unit: { include: { property: { select: { name: true, hostId: true } } } }, ...include } });
  if (!b) { res.status(404).json({ error: 'not_found', message: 'This link isn’t valid.' }); return null; }
  if (linkExpired(b)) { res.status(410).json({ error: 'expired', message: 'This link has expired. Please email support@simonstays.co.za if you need anything.' }); return null; }
  return b;
}

// GET /public/thread/:token — the conversation. Opening it counts as reading it,
// except from an admin's preview of the invoice (?preview=1).
router.get('/:token', async (req, res, next) => {
  try {
    const b = await bookingOf(req, res, { messages: { where: { unsentAt: null }, orderBy: { createdAt: 'asc' }, include: { offer: true } } });
    if (!b) return;
    if (req.query.preview !== '1') await prisma.message.updateMany({ where: { bookingId: b.id, sender: 'host', readAt: null, unsentAt: null }, data: { readAt: new Date() } });
    res.set('Cache-Control', 'no-store');
    res.json({
      ref: b.ref || null, guestName: b.guestName || null,
      place: [b.unit?.property?.name, b.unit?.name && `Unit ${b.unit.name}`].filter(Boolean).join(' · ') || null,
      checkIn: iso(b.checkIn), checkOut: iso(shownCheckOut(b)),
      messages: b.messages.map((m) => {
        const offer = m.offer ? offerOut(m.offer, b) : null;
        return { id: m.id, mine: m.sender === 'guest', body: m.body, createdAt: m.createdAt, payLink: offer && offer.state === 'open' ? offer.link : null };
      }),
    });
  } catch (e) { next(e); }
});

// POST /public/thread/:token { body } — the guest replies.
router.post('/:token', async (req, res, next) => {
  try {
    const b = await bookingOf(req, res); if (!b) return;
    const body = String((req.body || {}).body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'empty', message: 'Type a message first.' });
    const hostId = b.hostId || b.unit?.property?.hostId;
    const m = await prisma.message.create({ data: { hostId, bookingId: b.id, sender: 'guest', authorName: b.guestName || 'Guest', body } });
    res.status(201).json({ message: { id: m.id, mine: true, body: m.body, createdAt: m.createdAt, payLink: null } });
  } catch (e) { next(e); }
});

module.exports = router;
