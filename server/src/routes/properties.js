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
  const b = req.body || {};
  const data = {
    name: b.name ?? req.property.name,
    address: b.address ?? req.property.address,
    description: b.description ?? req.property.description,
  };
  ['security', 'checkInTime', 'checkOutTime', 'backupPower', 'backupWater', 'parkingNotes']
    .forEach((k) => { if (k in b) data[k] = b[k] === '' ? null : b[k]; });
  ['latitude', 'longitude'].forEach((k) => { if (k in b) data[k] = (b[k] === '' || b[k] == null) ? null : Number(b[k]); });
  if ('parkingBays' in b) data.parkingBays = (b.parkingBays === '' || b.parkingBays == null) ? null : Number(b.parkingBays);
  const property = await prisma.property.update({ where: { id: req.property.id }, data });
  res.json({ property });
});

// DELETE /properties/:id
router.delete('/:id', requireOwnedProperty, async (req, res) => {
  await prisma.property.delete({ where: { id: req.property.id } });
  res.json({ ok: true });
});

module.exports = router;
