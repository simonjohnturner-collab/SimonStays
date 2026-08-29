const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, requireOwnedUnit } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

const TYPES = ['airbnb', 'booking', 'lekkeslaap', 'other'];

// GET /units/:unitId/channels
router.get('/units/:unitId/channels', requireOwnedUnit, async (req, res) => {
  const channels = await prisma.channelConnection.findMany({
    where: { unitId: req.unit.id }, orderBy: { createdAt: 'asc' },
  });
  res.json({ channels });
});

// POST /units/:unitId/channels { type, importUrl, label }
router.post('/units/:unitId/channels', requireOwnedUnit, async (req, res) => {
  const { type, importUrl, label } = req.body || {};
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'invalid_type', allowed: TYPES });
  if (!importUrl) return res.status(400).json({ error: 'importUrl_required' });
  const channel = await prisma.channelConnection.create({
    data: { unitId: req.unit.id, type, importUrl, label: label || null },
  });
  res.status(201).json({ channel });
});

// DELETE /channels/:channelId
router.delete('/channels/:channelId', async (req, res) => {
  const channel = await prisma.channelConnection.findUnique({
    where: { id: req.params.channelId },
    include: { unit: { include: { property: true } } },
  });
  if (!channel) return res.status(404).json({ error: 'not_found' });
  if (channel.unit.property.hostId !== req.hostId) return res.status(403).json({ error: 'forbidden' });
  await prisma.channelConnection.delete({ where: { id: channel.id } });
  res.json({ ok: true });
});

module.exports = router;
