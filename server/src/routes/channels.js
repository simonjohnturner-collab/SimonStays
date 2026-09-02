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
  // Reject a link already used by ANY of the host's units (else one unit's
  // calendar gets mirrored onto another — crossed wires).
  const clash = await prisma.channelConnection.findFirst({
    where: { importUrl, unit: { property: { hostId: req.unit.property.hostId } } },
    include: { unit: { include: { property: true } } },
  });
  if (clash) {
    const same = clash.unitId === req.unit.id;
    return res.status(409).json({
      error: same ? 'channel_already_connected' : 'duplicate_import_url',
      message: same
        ? 'This calendar link is already on this unit.'
        : `That calendar link is already used by ${clash.unit.property.name} · ${clash.unit.name}. Each unit needs its own Airbnb calendar link.`,
    });
  }
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
