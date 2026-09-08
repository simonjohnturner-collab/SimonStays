// Guest contact book — a track record of guests (from Airbnb names, invoices and
// direct bookings): contact details, notes and previous damages.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

function fmt(g) {
  return { id: g.id, name: g.name, phone: g.phone || '', email: g.email || '', address: g.address || '', notes: g.notes || '', damages: g.damages || '', createdAt: g.createdAt };
}
function clean(b) {
  return {
    name: String(b.name || '').trim(),
    phone: b.phone ? String(b.phone).trim() : null,
    email: b.email ? String(b.email).trim() : null,
    address: b.address ? String(b.address).trim() : null,
    notes: b.notes ? String(b.notes).trim() : null,
    damages: b.damages ? String(b.damages).trim() : null,
  };
}

// GET /guests?q= — the contact book, optionally filtered by name/phone/email.
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const where = { hostId: req.hostId };
  if (q) where.OR = [
    { name: { contains: q, mode: 'insensitive' } },
    { phone: { contains: q, mode: 'insensitive' } },
    { email: { contains: q, mode: 'insensitive' } },
  ];
  const rows = await prisma.guest.findMany({ where, orderBy: { name: 'asc' } });
  res.json({ guests: rows.map(fmt) });
});

router.post('/', async (req, res) => {
  const data = clean(req.body || {});
  if (!data.name) return res.status(400).json({ error: 'name_required' });
  const g = await prisma.guest.create({ data: { hostId: req.hostId, ...data } });
  res.status(201).json({ guest: fmt(g) });
});

router.put('/:id', async (req, res) => {
  const existing = await prisma.guest.findFirst({ where: { id: req.params.id, hostId: req.hostId }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const data = clean(req.body || {});
  if (!data.name) return res.status(400).json({ error: 'name_required' });
  const g = await prisma.guest.update({ where: { id: existing.id }, data });
  res.json({ guest: fmt(g) });
});

router.delete('/:id', async (req, res) => {
  const existing = await prisma.guest.findFirst({ where: { id: req.params.id, hostId: req.hostId }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  await prisma.guest.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

// POST /guests/import-from-bookings — add any booking guest names not yet in the
// book (names only; contact details are filled in by hand or from invoices).
router.post('/import-from-bookings', async (req, res) => {
  const PLACEHOLDER = new Set(['blocked', 'airbnb', '(guest)', 'guest', '']);
  const bookings = await prisma.booking.findMany({ where: { hostId: req.hostId, guestName: { not: null } }, select: { guestName: true } });
  const existing = await prisma.guest.findMany({ where: { hostId: req.hostId }, select: { name: true } });
  const have = new Set(existing.map((g) => g.name.trim().toLowerCase()));
  const toAdd = new Set();
  bookings.forEach((b) => {
    const n = (b.guestName || '').trim();
    if (!n || PLACEHOLDER.has(n.toLowerCase()) || have.has(n.toLowerCase())) return;
    toAdd.add(n);
  });
  if (toAdd.size) await prisma.guest.createMany({ data: [...toAdd].map((name) => ({ hostId: req.hostId, name })) });
  res.json({ added: toAdd.size });
});

module.exports = router;
