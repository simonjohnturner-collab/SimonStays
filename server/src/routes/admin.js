// SimonStays super-admin: only the admin account (see requireAdmin) may list
// every host and mint a token to sign in as any of them ("impersonate"). Once
// signed in as a host, the whole app is scoped to that host by their JWT, so
// the admin sees exactly what that host sees — properties, calendar, pricing,
// payouts, everything.
const express = require('express');
const prisma = require('../lib/prisma');
const { sign } = require('../lib/jwt');
const { authHost, requireAdmin, isAdminEmail } = require('../middleware/auth');

const router = express.Router();
router.use(authHost, requireAdmin);

// GET /admin/hosts — every host with a few headline counts.
router.get('/hosts', async (req, res) => {
  const hosts = await prisma.host.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      _count: { select: { properties: true, bookings: true, invoices: true } },
      properties: { select: { _count: { select: { units: true } } } },
    },
  });
  res.json({
    hosts: hosts.map((h) => ({
      id: h.id,
      email: h.email,
      name: h.name,
      contactPhone: h.contactPhone,
      createdAt: h.createdAt,
      isAdmin: isAdminEmail(h.email),
      hasPayout: !!(h.payoutAccountNumber || h.payoutBankName),
      counts: {
        properties: h._count.properties,
        units: h.properties.reduce((n, p) => n + p._count.units, 0),
        bookings: h._count.bookings,
        invoices: h._count.invoices,
      },
    })),
  });
});

// POST /admin/impersonate/:hostId — a normal host token for that host.
router.post('/impersonate/:hostId', async (req, res) => {
  const host = await prisma.host.findUnique({ where: { id: req.params.hostId } });
  if (!host) return res.status(404).json({ error: 'host_not_found' });
  res.json({
    token: sign(host),
    host: { id: host.id, email: host.email, name: host.name },
  });
});

// ---- SimonStays admin portal: every host's properties, transactions and guest messages ----
const { FEE_PERCENT, feeOf, grossOf } = require('../utils/fees');
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const ownedBy = (hostId) => ({ OR: [{ hostId }, { unit: { property: { hostId } } }] });
const hostOfBooking = (b) => b.hostId || b.unit?.property?.hostId || null;
const BOOKING_INCLUDE = { unit: { include: { property: { select: { name: true, hostId: true } } } } };

async function hostNames() {
  const hs = await prisma.host.findMany({ select: { id: true, name: true, email: true } });
  return Object.fromEntries(hs.map((h) => [h.id, h.name || h.email]));
}
function dateRange(q) {
  const r = {};
  if (q.from) r.gte = new Date(`${q.from}T00:00:00Z`);
  if (q.to) r.lt = new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86400000);
  return Object.keys(r).length ? r : null;
}

// GET /admin/properties — every property with its host, units and listing state.
router.get('/properties', async (req, res) => {
  const names = await hostNames();
  const props = await prisma.property.findMany({
    orderBy: { name: 'asc' },
    include: { units: { select: { id: true, name: true } } },
  });
  const counts = await prisma.booking.groupBy({ by: ['unitId'], where: { status: { not: 'cancelled' } }, _count: true });
  const byUnit = Object.fromEntries(counts.map((c) => [c.unitId, c._count]));
  res.json({
    properties: props.map((p) => ({
      id: p.id, name: p.name, address: p.address || null, hostId: p.hostId, host: names[p.hostId] || '—',
      units: p.units.map((u) => u.name),
      bookings: p.units.reduce((n, u) => n + (byUnit[u.id] || 0), 0),
      createdAt: p.createdAt,
    })),
  });
});

// GET /admin/transactions?hostId=&from=&to=&status= — every SimonStays booking
// (made on the website/app) with what was paid and the SimonStays fee.
// Dates filter on when the booking was made.
router.get('/transactions', async (req, res) => {
  const names = await hostNames();
  const where = { source: 'website' };
  const AND = [];
  if (req.query.hostId) AND.push(ownedBy(req.query.hostId));
  const range = dateRange(req.query);
  if (range) where.createdAt = range;
  if (req.query.status) where.status = req.query.status;
  if (AND.length) where.AND = AND;
  const bookings = await prisma.booking.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 1000,
    include: { ...BOOKING_INCLUDE, payments: { orderBy: { createdAt: 'desc' } } },
  });
  const rows = bookings.map((b) => {
    const hostId = hostOfBooking(b);
    const grossCents = grossOf(b);
    const earns = b.status === 'confirmed'; // the fee is only earned on a confirmed stay
    const feeCents = earns ? feeOf(grossCents) : 0;
    const card = b.payments.find((p) => p.status === 'COMPLETE');
    return {
      id: b.id, ref: b.ref || null, createdAt: b.createdAt, status: b.status,
      hostId, host: names[hostId] || '—',
      property: b.unit?.property?.name || null, unit: b.unit?.name || null,
      guestName: b.guestName || null, guestEmail: b.guestEmail || null,
      checkIn: iso(b.checkIn), checkOut: iso(b.checkOut),
      method: b.payments.length ? 'Card' : 'EFT',
      paygateRef: card && card.raw && card.raw.TRANSACTION_ID ? String(card.raw.TRANSACTION_ID) : null,
      totalCents: b.totalCents != null ? b.totalCents : (b.quotedCents || 0),
      depositCents: b.depositCents || 0,
      paidCents: b.amountPaidCents || 0,
      grossCents, feeCents, hostNetCents: earns ? grossCents - feeCents : 0,
    };
  });
  const confirmed = rows.filter((r) => r.status === 'confirmed');
  const sum = (xs, k) => xs.reduce((n, r) => n + r[k], 0);
  res.json({
    feePercent: FEE_PERCENT,
    rows,
    totals: {
      bookings: confirmed.length,
      grossCents: sum(confirmed, 'grossCents'),
      feeCents: sum(confirmed, 'feeCents'),
      hostNetCents: sum(confirmed, 'hostNetCents'),
      collectedCents: sum(rows, 'paidCents'),
      pending: rows.filter((r) => r.status === 'pending').length,
      cancelled: rows.filter((r) => r.status === 'cancelled').length,
    },
  });
});

// GET /admin/messages?hostId= — every booking conversation, latest first.
// Read-only: viewing here never marks anything as read for the host or guest.
router.get('/messages', async (req, res) => {
  const names = await hostNames();
  const bookings = await prisma.booking.findMany({
    where: { messages: { some: {} }, ...(req.query.hostId ? ownedBy(req.query.hostId) : {}) },
    include: { ...BOOKING_INCLUDE, messages: { orderBy: { createdAt: 'desc' }, take: 1 }, _count: { select: { messages: true } } },
    take: 500,
  });
  const threads = bookings.map((b) => {
    const hostId = hostOfBooking(b);
    return {
      bookingId: b.id, ref: b.ref || null, source: b.source, status: b.status,
      hostId, host: names[hostId] || '—',
      property: b.unit?.property?.name || null, unit: b.unit?.name || null,
      guestName: b.guestName || null, checkIn: iso(b.checkIn), checkOut: iso(b.checkOut),
      count: b._count.messages,
      last: b.messages[0] ? { body: b.messages[0].body, sender: b.messages[0].sender, createdAt: b.messages[0].createdAt } : null,
    };
  }).sort((a, b) => new Date(b.last?.createdAt || 0) - new Date(a.last?.createdAt || 0));
  res.json({ threads });
});

// GET /admin/messages/:bookingId — one conversation in full.
router.get('/messages/:bookingId', async (req, res) => {
  const b = await prisma.booking.findUnique({
    where: { id: req.params.bookingId },
    include: { ...BOOKING_INCLUDE, messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!b) return res.status(404).json({ error: 'not_found' });
  const names = await hostNames();
  res.json({
    booking: {
      id: b.id, ref: b.ref || null, host: names[hostOfBooking(b)] || '—', guestName: b.guestName || null,
      property: b.unit?.property?.name || null, unit: b.unit?.name || null, checkIn: iso(b.checkIn), checkOut: iso(b.checkOut),
    },
    messages: b.messages.map((m) => ({ id: m.id, sender: m.sender, body: m.body, createdAt: m.createdAt, readAt: m.readAt, automatic: !!m.scheduleId })),
  });
});

module.exports = router;
