const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, requireOwnedUnit } = require('../middleware/auth');
const { checkAvailability, syncUnit } = require('../utils/sync');
const { dateOnly } = require('../utils/ical');
const { quote } = require('../utils/pricing');

const router = express.Router();
router.use(authHost);

// GET /units/:unitId/availability?checkIn=&checkOut=  (live: syncs channels first)
router.get('/units/:unitId/availability', requireOwnedUnit, async (req, res) => {
  const { checkIn, checkOut } = req.query;
  if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn_and_checkOut_required' });
  try { await syncUnit(req.unit.id); } catch (e) { /* best-effort live refresh */ }
  const result = await checkAvailability(req.unit.id, checkIn, checkOut, null);
  res.json(result);
});

// POST /units/:unitId/bookings — create a manual booking.
// A unit-less floating booking is created via POST /bookings/floating below.
router.post('/units/:unitId/bookings', requireOwnedUnit, async (req, res) => {
  const b = req.body || {};
  if (!b.checkIn || !b.checkOut) return res.status(400).json({ error: 'dates_required' });

  if (!b.override) {
    const avail = await checkAvailability(req.unit.id, b.checkIn, b.checkOut, null);
    if (avail.error) return res.status(400).json({ error: avail.error });
    if (!avail.available) return res.status(409).json({ error: 'dates_unavailable', conflicts: avail.conflicts });
  }

  const booking = await prisma.booking.create({
    data: {
      unitId: req.unit.id, hostId: req.hostId, source: 'manual', status: 'confirmed',
      guestName: b.guestName || null,
      checkIn: dateOnly(b.checkIn), checkOut: dateOnly(b.checkOut),
      cleaner: b.cleaner || null, comments: b.comments || null,
      leavingEarly: !!b.leavingEarly,
      earlyCheckIn: !!b.earlyCheckIn, lateCheckOut: !!b.lateCheckOut,
      extraMattress: !!b.extraMattress, hairDryer: !!b.hairDryer,
      ...paymentFields(b),
      cleans: { create: normalizeCleans(b.cleans) },
    },
    include: { cleans: true },
  });
  res.status(201).json({ booking });
});

// POST /bookings/floating — a booking not tied to a unit (shows yellow; blocks nothing).
router.post('/bookings/floating', async (req, res) => {
  const b = req.body || {};
  if (!b.checkIn || !b.checkOut) return res.status(400).json({ error: 'dates_required' });
  const booking = await prisma.booking.create({
    data: {
      unitId: null, hostId: req.hostId, source: 'manual', status: 'floating',
      guestName: b.guestName || null,
      checkIn: dateOnly(b.checkIn), checkOut: dateOnly(b.checkOut),
      cleaner: b.cleaner || null, comments: b.comments || null,
      leavingEarly: !!b.leavingEarly,
      earlyCheckIn: !!b.earlyCheckIn, lateCheckOut: !!b.lateCheckOut,
      extraMattress: !!b.extraMattress, hairDryer: !!b.hairDryer,
      pricingGroupId: await validGroup(req.hostId, b.pricingGroupId),
      ...paymentFields(b),
      cleans: { create: normalizeCleans(b.cleans) },
    },
    include: { cleans: true },
  });
  res.status(201).json({ booking });
});

// Return groupId if it belongs to the host, else null.
async function validGroup(hostId, groupId) {
  if (!groupId) return null;
  const g = await prisma.pricingGroup.findUnique({ where: { id: groupId } });
  return g && g.hostId === hostId ? groupId : null;
}

// GET /bookings/floating?from=&to= — the host's floating (unallocated) bookings.
router.get('/bookings/floating', async (req, res) => {
  const { from, to } = req.query;
  const where = { hostId: req.hostId, status: 'floating' };
  if (from) where.checkOut = { gte: new Date(from) };
  if (to) where.checkIn = { lte: new Date(to) };
  const bookings = await prisma.booking.findMany({ where, orderBy: { checkIn: 'asc' }, include: { cleans: true } });
  res.json({ bookings });
});

// GET /bookings/search?q= — find the host's bookings by guest name or Airbnb
// confirmation code (also comments), so the board can jump straight to one.
router.get('/bookings/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const bookings = await prisma.booking.findMany({
    where: {
      status: { not: 'cancelled' },
      OR: [
        { guestName: { contains: q, mode: 'insensitive' } },
        { resCode: { contains: q, mode: 'insensitive' } },
        { comments: { contains: q, mode: 'insensitive' } },
      ],
      // owned either directly (manual/floating) or via the unit's property
      AND: [{ OR: [{ hostId: req.hostId }, { unit: { property: { hostId: req.hostId } } }] }],
    },
    include: { unit: { include: { property: true } } },
    orderBy: { checkIn: 'asc' },
    take: 25,
  });
  const results = bookings.map((b) => ({
    id: b.id, unitId: b.unitId, status: b.status,
    guestName: b.guestName, resCode: b.resCode,
    checkIn: b.checkIn, checkOut: b.checkOut,
    unitName: b.unit ? b.unit.name : null,
    propertyName: b.unit ? b.unit.property.name : null,
  }));
  res.json({ results });
});

// Payment fields: paymentStatus ('paid'|'partial'|'unpaid') drives paid (fully paid only).
function paymentFields(b) {
  const out = {};
  if ('paymentStatus' in b) {
    out.paymentStatus = ['paid', 'partial', 'unpaid'].includes(b.paymentStatus) ? b.paymentStatus : 'unpaid';
    out.paid = out.paymentStatus === 'paid';
  } else if ('paid' in b) {
    out.paid = !!b.paid; out.paymentStatus = b.paid ? 'paid' : 'unpaid';
  }
  if ('amountOwingCents' in b) out.amountOwingCents = b.amountOwingCents === '' || b.amountOwingCents == null ? null : Math.round(Number(b.amountOwingCents));
  return out;
}

// Normalize insta-clean rows from the client into Prisma create-inputs.
function normalizeCleans(cleans) {
  if (!Array.isArray(cleans)) return [];
  return cleans
    .filter((c) => c && (c.date || c.cleaner || c.paymentMethod))
    .map((c) => ({
      date: c.date ? dateOnly(c.date) : null,
      paymentMethod: c.paymentMethod === 'direct' ? 'direct' : 'prepaid',
      cleaner: c.cleaner || null,
    }));
}

// PATCH /bookings/:id — edit any field the host owns (guest, paid, cleaner, dates, status…).
router.patch('/bookings/:id', async (req, res) => {
  const booking = await loadOwned(req, res); if (!booking) return;
  const b = req.body || {};
  const data = {};
  ['guestName', 'cleaner', 'comments'].forEach((k) => { if (k in b) data[k] = b[k]; });
  ['leavingEarly', 'earlyCheckIn', 'lateCheckOut', 'extraMattress', 'hairDryer']
    .forEach((k) => { if (k in b) data[k] = !!b[k]; });
  Object.assign(data, paymentFields(b));
  if ('status' in b) data.status = b.status;
  if ('checkIn' in b) data.checkIn = dateOnly(b.checkIn);
  if ('checkOut' in b) data.checkOut = dateOnly(b.checkOut);
  if ('cleans' in b) data.cleans = { deleteMany: {}, create: normalizeCleans(b.cleans) };
  if ('pricingGroupId' in b) data.pricingGroupId = await validGroup(req.hostId, b.pricingGroupId);
  // Allocate a floating booking to a unit (or unassign it back to floating).
  if ('unitId' in b) {
    if (b.unitId) {
      const unit = await prisma.unit.findUnique({ where: { id: b.unitId }, include: { property: true } });
      if (!unit || unit.property.hostId !== req.hostId) return res.status(400).json({ error: 'invalid_unit' });
      data.unitId = b.unitId;
      if (!('status' in b)) data.status = 'confirmed';
    } else { data.unitId = null; data.status = 'floating'; }
  }
  const updated = await prisma.booking.update({ where: { id: booking.id }, data, include: { cleans: true } });
  res.json({ booking: updated });
});

// GET /bookings/:id/quote — price this booking from its unit's rate card.
router.get('/bookings/:id/quote', async (req, res) => {
  const booking = await loadOwnedWithCleans(req, res); if (!booking) return;
  if (!booking.unit || !booking.unit.pricingGroupId) return res.status(404).json({ error: 'no_rate_card' });
  const rc = await prisma.pricingGroup.findUnique({ where: { id: booking.unit.pricingGroupId } });
  if (!rc) return res.status(404).json({ error: 'no_rate_card' });
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const prepaidCleans = (booking.cleans || []).filter((c) => c.paymentMethod !== 'direct').length;
  const q = quote(rc, {
    checkIn: iso(booking.checkIn), checkOut: iso(booking.checkOut),
    mattress: booking.extraMattress, earlyCheckIn: booking.earlyCheckIn, lateCheckOut: booking.lateCheckOut,
    cleans: 1 + prepaidCleans,
  });
  res.json({ quote: q });
});

async function loadOwnedWithCleans(req, res) {
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { unit: { include: { property: true } }, cleans: true },
  });
  if (!booking) { res.status(404).json({ error: 'not_found' }); return null; }
  const owner = booking.unit ? booking.unit.property.hostId : booking.hostId;
  if (owner !== req.hostId) { res.status(403).json({ error: 'forbidden' }); return null; }
  return booking;
}

// DELETE /bookings/:id
router.delete('/bookings/:id', async (req, res) => {
  const booking = await loadOwned(req, res); if (!booking) return;
  await prisma.booking.delete({ where: { id: booking.id } });
  res.json({ ok: true });
});

async function loadOwned(req, res) {
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { unit: { include: { property: true } } },
  });
  if (!booking) { res.status(404).json({ error: 'not_found' }); return null; }
  const owner = booking.unit ? booking.unit.property.hostId : booking.hostId;
  if (owner !== req.hostId) { res.status(403).json({ error: 'forbidden' }); return null; }
  return booking;
}

module.exports = router;
