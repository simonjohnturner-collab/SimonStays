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
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  res.json({ properties });
});

// PUT /properties/reorder { ids: [...] } — set the board order (index = position).
router.put('/reorder', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const owned = await prisma.property.findMany({ where: { id: { in: ids }, hostId: req.hostId }, select: { id: true } });
  const ownedSet = new Set(owned.map((o) => o.id));
  if (!ids.length || ids.some((id) => !ownedSet.has(id))) return res.status(400).json({ error: 'invalid_ids' });
  await prisma.$transaction(ids.map((id, i) => prisma.property.update({ where: { id }, data: { sortOrder: i } })));
  res.json({ ok: true });
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
  const { name, address, description } = req.body || {};
  const property = await prisma.property.update({
    where: { id: req.property.id },
    data: {
      name: name ?? req.property.name,
      address: address ?? req.property.address,
      description: description ?? req.property.description,
    },
  });
  res.json({ property });
});

// DELETE /properties/:id
router.delete('/:id', requireOwnedProperty, async (req, res) => {
  await prisma.property.delete({ where: { id: req.property.id } });
  res.json({ ok: true });
});

module.exports = router;
