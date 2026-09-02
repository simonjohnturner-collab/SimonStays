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
        include: { photos: { select: photoSelect, orderBy: photoOrder } },
      },
    },
  });
  res.json({ properties });
});

module.exports = router;
