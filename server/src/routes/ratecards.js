const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

const RATE_INT = ['breakageDepositCents', 'nights1Cents', 'nights2Cents', 'nights3Cents', 'nights4PlusCents', 'earlyCheckInCents', 'lateCheckOutCents', 'cleaningCents', 'mattressCents'];
const RATE_FLOAT = ['weeklyDiscountPercent', 'monthlyDiscountPercent', 'weekendFlexPercent', 'flex1Percent', 'flex2Percent', 'flex3Percent'];

// GET /ratecards — every unit (with its rate card) for the host, for the matrix.
router.get('/', async (req, res) => {
  const units = await prisma.unit.findMany({
    where: { property: { hostId: req.hostId } },
    include: { property: true, rateCard: true },
    orderBy: [{ property: { createdAt: 'asc' } }, { createdAt: 'asc' }],
  });
  res.json({
    units: units.map((u) => ({
      id: u.id, name: u.name, propertyName: u.property.name,
      rateCard: u.rateCard || { unitId: u.id },
    })),
  });
});

// PUT /ratecards { cards: [{ unitId, ...fields, specialDates }] } — batch upsert.
router.put('/', async (req, res) => {
  const cards = Array.isArray(req.body?.cards) ? req.body.cards : [];
  const owned = new Set((await prisma.unit.findMany({
    where: { property: { hostId: req.hostId } }, select: { id: true },
  })).map((u) => u.id));

  let saved = 0;
  for (const c of cards) {
    if (!owned.has(c.unitId)) continue;
    const data = {};
    RATE_INT.forEach((k) => { if (k in c) data[k] = c[k] === '' || c[k] == null ? null : Math.round(Number(c[k])); });
    RATE_FLOAT.forEach((k) => { if (k in c) data[k] = Number(c[k]) || 0; });
    if ('specialDates' in c) data.specialDates = c.specialDates;
    await prisma.rateCard.upsert({ where: { unitId: c.unitId }, update: data, create: { unitId: c.unitId, ...data } });
    saved++;
  }
  res.json({ ok: true, saved });
});

module.exports = router;
