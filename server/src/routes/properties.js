const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, requireOwnedProperty } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

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

module.exports = router;
