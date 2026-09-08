// Service providers the host works with — cleaners, electricians, plumbers,
// handymen, etc. Cleaners here also feed the checkout-cleaner dropdowns.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

function fmt(p) {
  return { id: p.id, name: p.name, role: p.role, phone: p.phone || '', notes: p.notes || '', propertyIds: Array.isArray(p.propertyIds) ? p.propertyIds : [] };
}
function clean(b) {
  return {
    name: String(b.name || '').trim(),
    role: String(b.role || 'Cleaner').trim() || 'Cleaner',
    phone: b.phone ? String(b.phone).trim() : null,
    notes: b.notes ? String(b.notes).trim() : null,
    propertyIds: Array.isArray(b.propertyIds) ? b.propertyIds.filter(Boolean) : [],
  };
}

router.get('/', async (req, res) => {
  const rows = await prisma.serviceProvider.findMany({ where: { hostId: req.hostId }, orderBy: [{ role: 'asc' }, { name: 'asc' }] });
  res.json({ providers: rows.map(fmt) });
});

router.post('/', async (req, res) => {
  const data = clean(req.body || {});
  if (!data.name) return res.status(400).json({ error: 'name_required' });
  const p = await prisma.serviceProvider.create({ data: { hostId: req.hostId, ...data } });
  res.status(201).json({ provider: fmt(p) });
});

router.put('/:id', async (req, res) => {
  const existing = await prisma.serviceProvider.findFirst({ where: { id: req.params.id, hostId: req.hostId }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const data = clean(req.body || {});
  if (!data.name) return res.status(400).json({ error: 'name_required' });
  const p = await prisma.serviceProvider.update({ where: { id: existing.id }, data });
  res.json({ provider: fmt(p) });
});

router.delete('/:id', async (req, res) => {
  const existing = await prisma.serviceProvider.findFirst({ where: { id: req.params.id, hostId: req.hostId }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  await prisma.serviceProvider.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

module.exports = router;
