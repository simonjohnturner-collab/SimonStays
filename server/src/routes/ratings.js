// The host's Ratings tab: how guests rated them, and the guests they can rate.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const { HOST_CATEGORIES, GUEST_CATEGORIES, guestEmailOf, summarise, guestRatingOf, ratingBlock, saveRating, RATING_WINDOW_MS } = require('../utils/ratings');
const { shownCheckOut } = require('../utils/ical');

const router = express.Router();
router.use(authHost);

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const owned = (hostId) => ({ OR: [{ hostId }, { unit: { property: { hostId } } }] });
const INCLUDE = { unit: { include: { property: { select: { name: true, hostId: true } } } }, guestAccount: { select: { email: true } } };
const stayOf = (b) => ({
  bookingId: b.id, ref: b.ref || null, guestName: b.guestName || null, guestEmail: guestEmailOf(b),
  propertyName: b.unit?.property?.name || null, unitName: b.unit?.name || null,
  checkIn: iso(b.checkIn), checkOut: iso(shownCheckOut(b)),
});

// GET /ratings — everything on the tab.
router.get('/', async (req, res, next) => {
  try {
    const now = Date.now();
    const received = await prisma.rating.findMany({ where: { kind: 'host', hostId: req.hostId }, orderBy: { createdAt: 'desc' }, include: { booking: { include: INCLUDE } } });
    const byProperty = {};
    received.forEach((r) => { (byProperty[r.propertyId] = byProperty[r.propertyId] || []).push(r); });

    const candidates = await prisma.booking.findMany({
      where: {
        ...owned(req.hostId), status: 'confirmed', unitId: { not: null }, checkOut: { gte: new Date(now - RATING_WINDOW_MS - 864e5), lte: new Date(now + 864e5) },
        ratings: { none: { kind: 'guest' } }, OR: [{ guestEmail: { not: null } }, { guestAccountId: { not: null } }],
      },
      include: INCLUDE, orderBy: { checkOut: 'desc' },
    });
    const toRate = await Promise.all(candidates.filter((b) => !ratingBlock(b, now)).map(async (b) => ({ ...stayOf(b), guestRating: await guestRatingOf(guestEmailOf(b)) })));
    const given = await prisma.rating.findMany({ where: { kind: 'guest', hostId: req.hostId }, orderBy: { createdAt: 'desc' }, take: 100, include: { booking: { include: INCLUDE } } });

    res.json({
      hostCategories: HOST_CATEGORIES,
      guestCategories: GUEST_CATEGORIES,
      overall: summarise(received, 'host'),
      properties: Object.values(byProperty).map((rows) => ({ propertyId: rows[0].propertyId, name: rows[0].booking.unit?.property?.name || 'Property', rating: summarise(rows, 'host') })),
      received: received.slice(0, 100).map((r) => ({ id: r.id, average: r.average, scores: r.scores, createdAt: r.createdAt, ...stayOf(r.booking) })),
      toRate,
      given: given.map((r) => ({ id: r.id, average: r.average, scores: r.scores, createdAt: r.createdAt, ...stayOf(r.booking) })),
    });
  } catch (e) { next(e); }
});

async function ownedBooking(req, res) {
  const b = await prisma.booking.findFirst({ where: { id: req.params.bookingId, ...owned(req.hostId) }, include: INCLUDE });
  if (!b) res.status(404).json({ error: 'not_found' });
  return b;
}

// GET /ratings/booking/:bookingId/guest — the guest's rating, from every host, on one of this host's bookings.
router.get('/booking/:bookingId/guest', async (req, res, next) => {
  try {
    const b = await ownedBooking(req, res); if (!b) return;
    res.json({ rating: await guestRatingOf(guestEmailOf(b)) });
  } catch (e) { next(e); }
});

// POST /ratings/booking/:bookingId { scores } — the host rates the guest.
router.post('/booking/:bookingId', async (req, res, next) => {
  try {
    const b = await ownedBooking(req, res); if (!b) return;
    const r = await saveRating(b, 'guest', (req.body || {}).scores);
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
