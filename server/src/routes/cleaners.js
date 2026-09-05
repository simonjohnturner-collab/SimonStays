// The host's list of cleaner names, used to populate dropdowns on the booking
// editor and the checkout-clean form.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

router.get('/', async (req, res) => {
  const host = await prisma.host.findUnique({ where: { id: req.hostId }, select: { cleaners: true } });
  res.json({ cleaners: Array.isArray(host?.cleaners) ? host.cleaners : [] });
});

router.put('/', async (req, res) => {
  const list = Array.isArray(req.body?.cleaners) ? req.body.cleaners.map((s) => String(s).trim()).filter(Boolean) : [];
  const host = await prisma.host.update({ where: { id: req.hostId }, data: { cleaners: list }, select: { cleaners: true } });
  res.json({ cleaners: host.cleaners });
});

module.exports = router;
