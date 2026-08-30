const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, requireOwnedProperty, requireOwnedUnit } = require('../middleware/auth');
const { syncUnit } = require('../utils/sync');

const router = express.Router();
router.use(authHost);

// POST /units { propertyId, name, capacity }
router.post('/', async (req, res) => {
  const { propertyId, name, capacity } = req.body || {};
  if (!propertyId || !name) return res.status(400).json({ error: 'propertyId_and_name_required' });
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property || property.hostId !== req.hostId) return res.status(403).json({ error: 'forbidden' });
  const unit = await prisma.unit.create({
    data: { propertyId, name, capacity: capacity != null ? Number(capacity) : null },
  });
  res.status(201).json({ unit });
});

// GET /units/:id — one unit with channels + feed URL.
router.get('/:id', requireOwnedUnit, async (req, res) => {
  res.json({ unit: withFeedUrl(req.unit) });
});

// PATCH /units/:id { name, capacity }
router.patch('/:id', requireOwnedUnit, async (req, res) => {
  const { name, capacity } = req.body || {};
  const unit = await prisma.unit.update({
    where: { id: req.unit.id },
    data: { name: name ?? req.unit.name, capacity: capacity != null ? Number(capacity) : req.unit.capacity },
  });
  res.json({ unit });
});

// DELETE /units/:id
router.delete('/:id', requireOwnedUnit, async (req, res) => {
  await prisma.unit.delete({ where: { id: req.unit.id } });
  res.json({ ok: true });
});

// GET /units/:id/bookings?from=ISO&to=ISO
router.get('/:id/bookings', requireOwnedUnit, async (req, res) => {
  const { from, to } = req.query;
  const where = { unitId: req.unit.id, status: { not: 'cancelled' } };
  if (from) where.checkOut = { gte: new Date(from) };
  if (to) where.checkIn = { lte: new Date(to) };
  const bookings = await prisma.booking.findMany({ where, orderBy: { checkIn: 'asc' }, include: { cleans: true } });
  res.json({ bookings });
});

// POST /units/:id/sync — pull this unit's channel calendars now.
router.post('/:id/sync', requireOwnedUnit, async (req, res) => {
  try {
    const summary = await syncUnit(req.unit.id);
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ error: 'sync_failed', message: e.message });
  }
});

function withFeedUrl(unit) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return { ...unit, feedUrl: `${base}/feed/${unit.id}.ics?token=${unit.publishToken}` };
}

module.exports = router;
