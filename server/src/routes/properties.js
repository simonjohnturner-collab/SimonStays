const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, requireOwnedProperty } = require('../middleware/auth');
const { quote } = require('../utils/pricing');

const router = express.Router();
router.use(authHost);

const RATE_INT = ['nights1Cents', 'nights2Cents', 'nights3Cents', 'nights4Cents', 'nights5PlusCents', 'cleaningCents', 'mattressCents'];
const RATE_FLOAT = ['weeklyDiscountPercent', 'monthlyDiscountPercent', 'weekendSurchargePercent', 'publicHolidaySurchargePercent', 'christmasSurchargePercent', 'easterSurchargePercent'];

// GET /properties — all of the host's properties, with units.
router.get('/', async (req, res) => {
  const properties = await prisma.property.findMany({
    where: { hostId: req.hostId },
    include: { units: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ properties });
});

// POST /properties { name, address }
router.post('/', async (req, res) => {
  const { name, address } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name_required' });
  const property = await prisma.property.create({
    data: { hostId: req.hostId, name, address: address || null },
  });
  res.status(201).json({ property });
});

// PATCH /properties/:id { name, address }
router.patch('/:id', requireOwnedProperty, async (req, res) => {
  const { name, address } = req.body || {};
  const property = await prisma.property.update({
    where: { id: req.property.id },
    data: { name: name ?? req.property.name, address: address ?? req.property.address },
  });
  res.json({ property });
});

// DELETE /properties/:id
router.delete('/:id', requireOwnedProperty, async (req, res) => {
  await prisma.property.delete({ where: { id: req.property.id } });
  res.json({ ok: true });
});

// ---- Rate card (pricing sheet) ----

// GET /properties/:id/ratecard
router.get('/:id/ratecard', requireOwnedProperty, async (req, res) => {
  const rateCard = await prisma.rateCard.findUnique({ where: { propertyId: req.property.id } });
  res.json({ rateCard: rateCard || { propertyId: req.property.id } });
});

// PUT /properties/:id/ratecard
router.put('/:id/ratecard', requireOwnedProperty, async (req, res) => {
  const b = req.body || {};
  const data = {};
  RATE_INT.forEach((k) => { if (k in b) data[k] = b[k] === '' || b[k] == null ? null : Math.round(Number(b[k])); });
  RATE_FLOAT.forEach((k) => { if (k in b) data[k] = Number(b[k]) || 0; });
  if ('specialDates' in b) data.specialDates = b.specialDates;
  const rateCard = await prisma.rateCard.upsert({
    where: { propertyId: req.property.id },
    update: data,
    create: { propertyId: req.property.id, ...data },
  });
  res.json({ rateCard });
});

// POST /properties/:id/quote { checkIn, checkOut, mattress, cleaning }
router.post('/:id/quote', requireOwnedProperty, async (req, res) => {
  const rc = await prisma.rateCard.findUnique({ where: { propertyId: req.property.id } });
  if (!rc) return res.status(404).json({ error: 'no_rate_card' });
  const q = quote(rc, req.body || {});
  if (!q) return res.status(400).json({ error: 'invalid_dates' });
  res.json({ quote: q });
});

module.exports = router;
