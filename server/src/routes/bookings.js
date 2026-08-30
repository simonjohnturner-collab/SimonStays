const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, requireOwnedUnit } = require('../middleware/auth');
const { checkAvailability, syncUnit } = require('../utils/sync');
const { dateOnly } = require('../utils/ical');

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
      unitId: req.unit.id, source: 'manual', status: 'confirmed',
      guestName: b.guestName || null,
      checkIn: dateOnly(b.checkIn), checkOut: dateOnly(b.checkOut),
      paid: !!b.paid, cleaner: b.cleaner || null, comments: b.comments || null,
      leavingEarly: !!b.leavingEarly,
      earlyCheckIn: !!b.earlyCheckIn, lateCheckOut: !!b.lateCheckOut,
      extraMattress: !!b.extraMattress, hairDryer: !!b.hairDryer,
      cleans: { create: normalizeCleans(b.cleans) },
    },
    include: { cleans: true },
  });
  res.status(201).json({ booking });
});

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
  ['paid', 'leavingEarly', 'earlyCheckIn', 'lateCheckOut', 'extraMattress', 'hairDryer']
    .forEach((k) => { if (k in b) data[k] = !!b[k]; });
  if ('status' in b) data.status = b.status;
  if ('checkIn' in b) data.checkIn = dateOnly(b.checkIn);
  if ('checkOut' in b) data.checkOut = dateOnly(b.checkOut);
  if ('cleans' in b) data.cleans = { deleteMany: {}, create: normalizeCleans(b.cleans) };
  const updated = await prisma.booking.update({ where: { id: booking.id }, data, include: { cleans: true } });
  res.json({ booking: updated });
});

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
  if (booking.unit.property.hostId !== req.hostId) { res.status(403).json({ error: 'forbidden' }); return null; }
  return booking;
}

module.exports = router;
