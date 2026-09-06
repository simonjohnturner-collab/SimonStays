// Smart-lock health: the host's smart-lock units, their battery, and the codes
// for current + upcoming stays (so we can reconcile that every stay has one).
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

router.get('/', async (req, res) => {
  const now = new Date();
  const units = await prisma.unit.findMany({
    where: { accessMethod: 'Smart lock', property: { hostId: req.hostId } },
    include: { property: { select: { name: true, sortOrder: true } } },
    orderBy: [{ property: { sortOrder: 'asc' } }, { name: 'asc' }],
  });
  const unitIds = units.map((u) => u.id);
  const bookings = unitIds.length ? await prisma.booking.findMany({
    where: { unitId: { in: unitIds }, status: 'confirmed', checkOut: { gt: now } },
    orderBy: { checkIn: 'asc' },
    select: { id: true, unitId: true, guestName: true, checkIn: true, checkOut: true, accessCode: true, source: true },
  }) : [];
  const byUnit = {};
  bookings.forEach((b) => {
    if (b.guestName === 'Blocked') return; // host blocks don't need a guest code
    (byUnit[b.unitId] = byUnit[b.unitId] || []).push(b);
  });
  res.json({
    units: units.map((u) => ({
      id: u.id, name: u.name, propertyName: u.property.name,
      lockBattery: u.lockBattery, smartLockUrl: u.smartLockUrl,
      bookings: byUnit[u.id] || [],
    })),
  });
});

module.exports = router;
