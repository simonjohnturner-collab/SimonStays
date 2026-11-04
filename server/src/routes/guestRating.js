// The guest rates their stay, from the link in their invitation. No account needed:
// the link is the key, and it only opens this.
const express = require('express');
const prisma = require('../lib/prisma');
const { bookingIdOf } = require('../utils/guestThread');
const { HOST_CATEGORIES, ratingBlock, saveRating } = require('../utils/ratings');
const { shownCheckOut } = require('../utils/ical');

const router = express.Router();
const iso = (d) => new Date(d).toISOString().slice(0, 10);

async function bookingOf(req, res) {
  const id = bookingIdOf(req.params.token, 'guest-rate');
  const b = id && await prisma.booking.findUnique({ where: { id }, include: { unit: { include: { property: { select: { name: true, hostId: true } } } }, guestAccount: { select: { email: true } }, ratings: { where: { kind: 'host' }, select: { id: true } } } });
  if (!b) res.status(404).json({ error: 'not_found', message: 'This link isn’t valid.' });
  return b || null;
}

// GET /public/rate/:token — what they're rating.
router.get('/:token', async (req, res, next) => {
  try {
    const b = await bookingOf(req, res); if (!b) return;
    res.set('Cache-Control', 'no-store');
    res.json({
      place: [b.unit?.property?.name, b.unit?.name && `Unit ${b.unit.name}`].filter(Boolean).join(' · ') || 'your stay',
      checkIn: iso(b.checkIn), checkOut: iso(shownCheckOut(b)),
      categories: HOST_CATEGORIES,
      rated: b.ratings.length > 0,
      blocked: ratingBlock(b),
    });
  } catch (e) { next(e); }
});

// POST /public/rate/:token { scores }
router.post('/:token', async (req, res, next) => {
  try {
    const b = await bookingOf(req, res); if (!b) return;
    const r = await saveRating(b, 'host', (req.body || {}).scores);
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
