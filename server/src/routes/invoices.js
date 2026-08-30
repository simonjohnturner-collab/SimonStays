const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const { quote } = require('../utils/pricing');

const router = express.Router();
router.use(authHost);

const SETTABLE = ['date', 'invoiceType', 'billToName', 'billToAddress', 'billToAttention',
  'billToEmail', 'billToPhone', 'lineItems', 'discountPercent', 'totalCents', 'dueNowCents',
  'specialConditions', 'status', 'bookingId'];

// GET /invoices — list (newest first).
router.get('/', async (req, res) => {
  const invoices = await prisma.invoice.findMany({ where: { hostId: req.hostId }, orderBy: { createdAt: 'desc' } });
  res.json({ invoices });
});

// GET /invoices/:id
router.get('/:id', async (req, res) => {
  const inv = await owned(req, res); if (!inv) return;
  res.json({ invoice: inv });
});

// POST /invoices — create. Optional { fromBookingId } prefills from a booking.
router.post('/', async (req, res) => {
  const body = req.body || {};
  const biller = await prisma.billerProfile.findUnique({ where: { hostId: req.hostId } });

  let prefill = {};
  if (body.fromBookingId) {
    prefill = await buildFromBooking(req.hostId, body.fromBookingId, biller);
    if (prefill.error) return res.status(prefill.status || 400).json({ error: prefill.error });
  }

  const number = await nextNumber(req.hostId);
  const data = {
    hostId: req.hostId,
    number,
    invoiceType: 'Accommodation',
    lineItems: [],
    specialConditions: biller?.specialConditions || null,
    billerSnapshot: snapshot(biller),
    ...prefill,
  };
  // explicit body fields win over prefill
  SETTABLE.forEach((k) => { if (k in body) data[k] = body[k]; });
  if (body.date) data.date = new Date(body.date);

  const invoice = await prisma.invoice.create({ data });
  res.status(201).json({ invoice });
});

// PATCH /invoices/:id
router.patch('/:id', async (req, res) => {
  const inv = await owned(req, res); if (!inv) return;
  const data = {};
  SETTABLE.forEach((k) => { if (k in (req.body || {})) data[k] = req.body[k]; });
  if (req.body?.date) data.date = new Date(req.body.date);
  const invoice = await prisma.invoice.update({ where: { id: inv.id }, data });
  res.json({ invoice });
});

// POST /invoices/:id/duplicate — copy for recurring billing (new number + today's date).
router.post('/:id/duplicate', async (req, res) => {
  const inv = await owned(req, res); if (!inv) return;
  const biller = await prisma.billerProfile.findUnique({ where: { hostId: req.hostId } });
  const number = await nextNumber(req.hostId);
  const { id, createdAt, updatedAt, number: _n, date: _d, ...rest } = inv;
  const invoice = await prisma.invoice.create({
    data: { ...rest, number, date: new Date(), status: 'draft', billerSnapshot: snapshot(biller) },
  });
  res.status(201).json({ invoice });
});

// DELETE /invoices/:id
router.delete('/:id', async (req, res) => {
  const inv = await owned(req, res); if (!inv) return;
  await prisma.invoice.delete({ where: { id: inv.id } });
  res.json({ ok: true });
});

// ---- helpers ----

async function owned(req, res) {
  const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!inv) { res.status(404).json({ error: 'not_found' }); return null; }
  if (inv.hostId !== req.hostId) { res.status(403).json({ error: 'forbidden' }); return null; }
  return inv;
}

async function nextNumber(hostId) {
  const biller = await prisma.billerProfile.upsert({
    where: { hostId }, update: { invoiceSeq: { increment: 1 } }, create: { hostId, invoiceSeq: 1 },
  });
  return `INV-${new Date().getFullYear()}-${String(biller.invoiceSeq).padStart(3, '0')}`;
}

function snapshot(b) {
  if (!b) return null;
  const { id, hostId, updatedAt, invoiceSeq, ...rest } = b;
  return rest;
}

// Build prefilled invoice fields from a booking (guest, dates, nights, add-ons).
// If the unit has a rate card, amounts are priced automatically.
async function buildFromBooking(hostId, bookingId, biller) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { unit: { include: { property: true } }, cleans: true },
  });
  if (!booking) return { error: 'booking_not_found', status: 404 };
  if (booking.unit.property.hostId !== hostId) return { error: 'forbidden', status: 403 };

  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const nights = Math.max(1, Math.round((new Date(booking.checkOut) - new Date(booking.checkIn)) / 86400000));
  const rc = booking.unit.pricingGroupId ? await prisma.pricingGroup.findUnique({ where: { id: booking.unit.pricingGroupId } }) : null;
  const prepaidCleans = booking.cleans.filter((c) => c.paymentMethod !== 'direct').length;
  const q = rc ? quote(rc, {
    checkIn: iso(booking.checkIn), checkOut: iso(booking.checkOut),
    mattress: booking.extraMattress, earlyCheckIn: booking.earlyCheckIn, lateCheckOut: booking.lateCheckOut,
    cleans: 1 + prepaidCleans,
  }) : null;

  // Accommodation line — nightly is the discount-net average so the total matches the quote.
  const nightlyCents = q ? Math.round((q.accommodationCents - q.discountCents) / q.nights) : 0;
  const lineItems = [{
    description: `${booking.unit.property.name} · ${booking.unit.name}`,
    dateIn: iso(booking.checkIn), dateOut: iso(booking.checkOut),
    qty: q ? q.nights : nights, nightlyCents, amountCents: 0,
  }];
  const line = (label, amountCents) => lineItems.push({ description: label, dateIn: '', dateOut: '', qty: 1, nightlyCents: 0, amountCents: amountCents || 0 });

  line(`Cleaning${prepaidCleans ? ` (${1 + prepaidCleans} cleans)` : ''}`, q ? q.cleaningCents : 0);
  if (booking.earlyCheckIn) line('Early check-in', q ? q.earlyCents : 0);
  if (booking.lateCheckOut) line('Late checkout', q ? q.lateCents : 0);
  if (booking.extraMattress) line('Extra mattress', q ? q.mattressCents : 0);
  if (booking.hairDryer) line('Hair dryer', 0);
  booking.cleans.filter((c) => c.paymentMethod === 'direct').forEach((c) =>
    line(`Insta clean${c.date ? ' (' + iso(c.date) + ')' : ''} — paid directly to cleaner`, 0));
  if (q && q.breakageCents) line('Refundable breakage deposit', q.breakageCents);

  const out = {
    bookingId,
    billToName: booking.guestName || '',
    lineItems,
    specialConditions: biller?.specialConditions || null,
  };
  if (q) out.dueNowCents = Math.round(q.totalCents / 2); // 50% deposit default
  return out;
}

module.exports = router;
