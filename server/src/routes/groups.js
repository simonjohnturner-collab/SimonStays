const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

const RATE_INT = ['breakageDepositCents', 'nights1Cents', 'nights2Cents', 'nights3Cents', 'nights4PlusCents', 'earlyCheckInCents', 'lateCheckOutCents', 'cleaningCents', 'mattressCents'];
const RATE_FLOAT = ['weeklyDiscountPercent', 'monthlyDiscountPercent', 'weekendFlexPercent', 'flex1Percent', 'flex2Percent', 'flex3Percent'];

// GET /groups — the host's pricing groups (with assigned unit ids).
router.get('/', async (req, res) => {
  const groups = await prisma.pricingGroup.findMany({
    where: { hostId: req.hostId },
    include: { units: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ groups: groups.map((g) => ({ ...g, unitIds: g.units.map((u) => u.id), units: undefined })) });
});

// POST /groups { name } — create an empty group.
router.post('/', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  const group = await prisma.pricingGroup.create({ data: { hostId: req.hostId, name } });
  res.status(201).json({ group });
});

// PUT /groups/:id — update name + pricing fields.
router.put('/:id', async (req, res) => {
  const g = await owned(req, res); if (!g) return;
  const b = req.body || {};
  const data = {};
  if ('name' in b && String(b.name).trim()) data.name = String(b.name).trim();
  RATE_INT.forEach((k) => { if (k in b) data[k] = b[k] === '' || b[k] == null ? null : Math.round(Number(b[k])); });
  RATE_FLOAT.forEach((k) => { if (k in b) data[k] = Number(b[k]) || 0; });
  if ('specialDates' in b) data.specialDates = b.specialDates;
  const group = await prisma.pricingGroup.update({ where: { id: g.id }, data });
  res.json({ group });
});

// DELETE /groups/:id — units in it become unassigned (SetNull).
router.delete('/:id', async (req, res) => {
  const g = await owned(req, res); if (!g) return;
  await prisma.pricingGroup.delete({ where: { id: g.id } });
  res.json({ ok: true });
});

async function owned(req, res) {
  const g = await prisma.pricingGroup.findUnique({ where: { id: req.params.id } });
  if (!g) { res.status(404).json({ error: 'not_found' }); return null; }
  if (g.hostId !== req.hostId) { res.status(403).json({ error: 'forbidden' }); return null; }
  return g;
}

module.exports = router;
