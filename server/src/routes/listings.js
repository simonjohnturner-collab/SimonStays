const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

const photoSelect = { id: true, sort: true, filename: true, contentType: true };
const photoOrder = [{ sort: 'asc' }, { createdAt: 'asc' }];

// GET /listings — the host's properties and units with descriptions and photo
// metadata (ids only; bytes are served separately by GET /photos/:id).
router.get('/', async (req, res) => {
  const properties = await prisma.property.findMany({
    where: { hostId: req.hostId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      photos: { select: photoSelect, orderBy: photoOrder },
      units: {
        orderBy: { createdAt: 'asc' },
        include: { photos: { select: photoSelect, orderBy: photoOrder }, channels: true },
      },
    },
  });
  // Attach each unit's calendar-sync links (the iCal we import bookings from, and
  // the lock/feed link channels subscribe to) so they can live on the Listings page.
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const out = properties.map((p) => ({
    ...p,
    units: p.units.map((u) => {
      const ch = (u.channels || [])[0];
      return { ...u, channels: undefined,
        importUrl: ch ? (ch.importUrl || '') : '', channelStatus: ch ? (ch.lastStatus || '') : '',
        feedUrl: `${base}/feed/${u.id}.ics?token=${u.publishToken}` };
    }),
  }));
  res.json({ properties: out });
});

module.exports = router;
