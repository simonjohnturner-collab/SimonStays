// The host's list of cleaner names, used to populate dropdowns on the booking
// editor and the checkout-clean form.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

router.get('/', async (req, res) => {
  // Cleaner names now come from the ServiceProvider directory (role = Cleaner);
  // falls back to the legacy Host.cleaners list if none exist yet.
  const providers = await prisma.serviceProvider.findMany({ where: { hostId: req.hostId, role: 'Cleaner' }, orderBy: { name: 'asc' }, select: { name: true } });
  if (providers.length) return res.json({ cleaners: providers.map((p) => p.name) });
  const host = await prisma.host.findUnique({ where: { id: req.hostId }, select: { cleaners: true } });
  res.json({ cleaners: Array.isArray(host?.cleaners) ? host.cleaners : [] });
});

router.put('/', async (req, res) => {
  const list = Array.isArray(req.body?.cleaners) ? req.body.cleaners.map((s) => String(s).trim()).filter(Boolean) : [];
  const host = await prisma.host.update({ where: { id: req.hostId }, data: { cleaners: list }, select: { cleaners: true } });
  res.json({ cleaners: host.cleaners });
});

module.exports = router;
