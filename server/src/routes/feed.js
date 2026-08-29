const express = require('express');
const prisma = require('../lib/prisma');
const { buildFeed } = require('../utils/ical');

// PUBLIC (no auth) — this is the URL each channel imports to block dates.
// GET /feed/:unitId.ics?token=<publishToken>&exclude=airbnb
const router = express.Router();

router.get('/:unitId', async (req, res) => {
  const unitId = String(req.params.unitId).replace(/\.ics$/i, '');
  const { token, exclude } = req.query;

  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) return res.status(404).type('text/plain').send('unit not found');
  if (!token || token !== unit.publishToken) return res.status(403).type('text/plain').send('bad token');

  const bookings = await prisma.booking.findMany({
    where: { unitId, status: 'confirmed' },
    orderBy: { checkIn: 'asc' },
  });

  const ics = buildFeed({ unitName: unit.name, bookings, excludeSource: exclude || null });
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `inline; filename="${unitId}.ics"`);
  res.send(ics);
});

module.exports = router;
