// SimonStays super-admin: only the admin account (see requireAdmin) may list
// every host and mint a token to sign in as any of them ("impersonate"). Once
// signed in as a host, the whole app is scoped to that host by their JWT, so
// the admin sees exactly what that host sees — properties, calendar, pricing,
// payouts, everything.
const express = require('express');
const prisma = require('../lib/prisma');
const { sign } = require('../lib/jwt');
const { authHost, requireAdmin, isAdminEmail } = require('../middleware/auth');
const { DOCUMENT_KINDS } = require('../utils/guestDocuments');
const { breakdownOf, offerLines } = require('../utils/paymentInvoice');

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
  const counts = await prisma.booking.groupBy({ by: ['unitId'], where: { status: { notIn: ['cancelled', 'enquiry'] } }, _count: true });
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
  where.status = req.query.status || { not: 'enquiry' }; // an enquiry isn't a transaction
  if (AND.length) where.AND = AND;
  const bookings = await prisma.booking.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 1000,
    include: {
      unit: { include: { pricingGroup: true, property: { select: { name: true, hostId: true } } } },
      payments: { orderBy: { createdAt: 'desc' } },
      offers: { where: { status: 'paid' }, orderBy: { createdAt: 'asc' } },
    },
  });
  // An invoice's extra units hold no payments of their own: the invoice's payment
  // sits on its first booking, so look it up by the invoice.
  const offerIds = bookings.map((b) => b.sourceOfferId).filter(Boolean);
  const offerPayments = offerIds.length ? await prisma.payment.findMany({ where: { offerId: { in: offerIds } } }) : [];
  const sourceOffers = offerIds.length ? await prisma.priceOffer.findMany({ where: { id: { in: offerIds } } }) : [];
  const rows = await Promise.all(bookings.map(async (b) => {
    const hostId = hostOfBooking(b);
    const grossCents = grossOf(b);
    const payments = b.payments.length ? b.payments : offerPayments.filter((p) => p.offerId === b.sourceOfferId);
    const earns = b.status === 'confirmed'; // the fee is only earned on a confirmed stay
    const feeCents = earns ? feeOf(grossCents) : 0;
    const card = payments.find((p) => p.status === 'COMPLETE');
    const invoice = b.offers.find((o) => o.kind !== 'change') || sourceOffers.find((o) => o.id === b.sourceOfferId) || null;
    return {
      id: b.id, ref: b.ref || null, createdAt: b.createdAt, status: b.status,
      hostId, host: names[hostId] || '—',
      property: b.unit?.property?.name || null, unit: b.unit?.name || null,
      guestName: b.guestName || null, guestEmail: b.guestEmail || null,
      checkIn: iso(b.checkIn), checkOut: iso(b.checkOut),
      // A card attempt that was abandoned doesn't make a confirmed booking a card payment.
      method: card || (b.status !== 'confirmed' && payments.some((p) => p.provider !== 'eft')) ? 'Card' : 'EFT',
      paygateRef: card && card.raw && card.raw.TRANSACTION_ID ? String(card.raw.TRANSACTION_ID) : null,
      totalCents: b.totalCents != null ? b.totalCents : (b.quotedCents || 0),
      depositCents: b.depositCents || 0,
      paidCents: b.amountPaidCents || 0,
      owingCents: b.amountOwingCents || 0,
      grossCents, feeCents, hostNetCents: earns ? grossCents - feeCents : 0,
      breakdown: await breakdownOf(b, invoice),
      sharedInvoice: !!invoice && invoice.bookingId !== b.id,
      changes: b.offers.filter((o) => o.kind === 'change').map((o) => ({ id: o.id, paidAt: o.paidAt, lines: offerLines(o), totalCents: o.totalCents })),
      payments: payments.filter((p) => p.status === 'COMPLETE').map((p) => ({ id: p.id, kind: p.kind, amountCents: p.amountCents, createdAt: p.updatedAt })),
    };
  }));
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

// GET /admin/guests?hostId= — everyone who has dealt with SimonStays: guests with
// an account and anyone who booked or enquired on the website/app, one row per
// person (matched by account, then email, then phone), latest activity first.
router.get('/guests', async (req, res) => {
  const names = await hostNames();
  const accounts = await prisma.guestAccount.findMany({ select: { id: true, email: true, name: true, phone: true, createdAt: true, documents: { select: { kind: true } } } });
  const accountById = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const accountByEmail = Object.fromEntries(accounts.map((a) => [a.email.trim().toLowerCase(), a]));
  const bookings = await prisma.booking.findMany({
    where: { source: 'website', ...(req.query.hostId ? ownedBy(req.query.hostId) : {}) },
    orderBy: { createdAt: 'desc' },
    include: BOOKING_INCLUDE,
  });

  const guests = new Map();
  const blank = (account) => ({
    account: account || null, name: account?.name || null, email: account?.email || null, phone: account?.phone || null,
    hostIds: new Set(), stays: [], lastActivity: account?.createdAt || null,
  });
  // Without a host filter, a guest who registered but hasn't booked still counts.
  if (!req.query.hostId) accounts.forEach((a) => guests.set(`a:${a.id}`, blank(a)));

  for (const b of bookings) {
    const email = (b.guestEmail || '').trim().toLowerCase();
    const phone = (b.guestPhone || '').replace(/\D/g, '');
    const account = accountById[b.guestAccountId] || accountByEmail[email] || null;
    const key = account ? `a:${account.id}` : email ? `e:${email}` : phone ? `p:${phone}` : `b:${b.id}`;
    if (!guests.has(key)) guests.set(key, blank(account));
    const g = guests.get(key);
    // Bookings arrive newest first, so the most recent details win.
    g.name = g.name || b.guestName || null;
    g.email = g.email || email || null;
    g.phone = g.phone || b.guestPhone || null;
    const hostId = hostOfBooking(b);
    if (hostId) g.hostIds.add(hostId);
    if (!g.lastActivity || b.createdAt > g.lastActivity) g.lastActivity = b.createdAt;
    g.stays.push({
      id: b.id, ref: b.ref || null, status: b.status, createdAt: b.createdAt,
      host: names[hostId] || '—', property: b.unit?.property?.name || null, unit: b.unit?.name || null,
      checkIn: iso(b.checkIn), checkOut: iso(b.checkOut),
      grossCents: grossOf(b), paidCents: b.amountPaidCents || 0,
    });
  }

  const today = iso(new Date());
  const rows = [...guests.entries()].map(([key, g]) => {
    const count = (status) => g.stays.filter((s) => s.status === status).length;
    const confirmed = g.stays.filter((s) => s.status === 'confirmed').sort((a, b) => a.checkIn.localeCompare(b.checkIn));
    return {
      key, name: g.name, email: g.email, phone: g.phone,
      hasAccount: !!g.account, joinedAt: g.account?.createdAt || null,
      accountId: g.account?.id || null,
      hasPhoto: !!g.account?.documents.some((d) => d.kind === 'photo'),
      hasId: !!g.account?.documents.some((d) => d.kind === 'id'),
      hosts: [...g.hostIds].map((id) => names[id] || '—'),
      lastActivity: g.lastActivity,
      counts: { confirmed: confirmed.length, pending: count('pending'), cancelled: count('cancelled'), enquiries: count('enquiry') },
      valueCents: confirmed.reduce((n, s) => n + s.grossCents, 0),
      paidCents: g.stays.reduce((n, s) => n + (s.status === 'cancelled' ? 0 : s.paidCents), 0),
      nextStay: confirmed.find((s) => s.checkOut >= today) || null,
      lastStay: [...confirmed].reverse().find((s) => s.checkOut < today) || null,
      stays: g.stays,
    };
  }).sort((a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0));

  res.json({
    guests: rows,
    totals: {
      guests: rows.length,
      accounts: rows.filter((r) => r.hasAccount).length,
      repeat: rows.filter((r) => r.counts.confirmed > 1).length,
      staying: rows.filter((r) => r.nextStay).length,
      pending: rows.filter((r) => r.counts.pending > 0).length,
    },
  });
});

// GET /admin/guests/:accountId/documents/:kind — a guest's profile picture or copy
// of ID. Its type was worked out from the file when it arrived.
router.get('/guests/:accountId/documents/:kind', async (req, res, next) => {
  try {
    if (!DOCUMENT_KINDS.includes(req.params.kind)) return res.status(404).json({ error: 'not_found' });
    const d = await prisma.guestDocument.findUnique({ where: { guestAccountId_kind: { guestAccountId: req.params.accountId, kind: req.params.kind } } });
    if (!d) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', d.contentType);
    res.set('Content-Disposition', `inline; filename="${d.filename.replace(/"/g, '')}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    res.send(Buffer.from(d.data));
  } catch (e) { next(e); }
});

// GET /admin/messages?hostId= — every booking conversation, latest first.
// Read-only: viewing here never marks anything as read for the host or guest.
router.get('/messages', async (req, res) => {
  const names = await hostNames();
  const bookings = await prisma.booking.findMany({
    where: { messages: { some: { unsentAt: null } }, ...(req.query.hostId ? ownedBy(req.query.hostId) : {}) },
    include: { ...BOOKING_INCLUDE, messages: { where: { unsentAt: null }, orderBy: { createdAt: 'desc' }, take: 1 }, _count: { select: { messages: { where: { unsentAt: null } } } } },
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
    include: { ...BOOKING_INCLUDE, messages: { where: { unsentAt: null }, orderBy: { createdAt: 'asc' } } },
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
