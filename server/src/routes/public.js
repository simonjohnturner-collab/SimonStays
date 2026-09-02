// Public (no-auth) API for the SimonStays shopfront booking site.
// Reuses the same availability + pricing engines as the admin app, so a public
// booking is priced and blocked identically and lands in the same calendar.

const express = require('express');
const prisma = require('../lib/prisma');
const { checkAvailability } = require('../utils/sync');
const { dateOnly } = require('../utils/ical');
const { quote } = require('../utils/pricing');

const router = express.Router();

const iso = (d) => new Date(d).toISOString().slice(0, 10);

// Which host's properties this public site sells. PUBLIC_HOST_ID pins it;
// otherwise, if there's exactly one host in the DB, use that.
async function publicHostId() {
  if (process.env.PUBLIC_HOST_ID) return process.env.PUBLIC_HOST_ID;
  const hosts = await prisma.host.findMany({ select: { id: true }, take: 2 });
  return hosts.length === 1 ? hosts[0].id : null;
}

// Cheapest nightly rate on a pricing group, for a "from R…" badge.
function fromNightlyCents(rc) {
  if (!rc) return null;
  const vals = [rc.firstNightCents, rc.additionalNightCents].filter((v) => v != null);
  return vals.length ? Math.min(...vals) : null;
}

const unitInclude = { pricingGroup: true, photos: { orderBy: { sort: 'asc' } } };

// GET /public/properties — browse list
router.get('/properties', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    if (!hostId) return res.json({ properties: [] });
    const props = await prisma.property.findMany({
      where: { hostId },
      orderBy: { sortOrder: 'asc' },
      include: { photos: { orderBy: { sort: 'asc' } }, units: { include: unitInclude } },
    });
    res.json({
      properties: props
        .filter((p) => p.units.length > 0)
        .map((p) => {
          const cover = p.photos[0] || p.units.flatMap((u) => u.photos)[0] || null;
          const fromCents = p.units.map((u) => fromNightlyCents(u.pricingGroup)).filter((v) => v != null);
          return {
            id: p.id, name: p.name, address: p.address || null, description: p.description || null,
            coverPhotoId: cover ? cover.id : null,
            maxCapacity: p.units.reduce((m, u) => Math.max(m, u.capacity || 0), 0),
            fromNightlyCents: fromCents.length ? Math.min(...fromCents) : null,
            unitCount: p.units.length,
          };
        }),
    });
  } catch (e) { next(e); }
});

// GET /public/properties/:id — detail (photos, description, bookable units)
router.get('/properties/:id', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    const p = await prisma.property.findFirst({
      where: { id: req.params.id, hostId },
      include: { photos: { orderBy: { sort: 'asc' } }, units: { include: unitInclude } },
    });
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json({
      property: {
        id: p.id, name: p.name, address: p.address || null, description: p.description || null,
        photos: p.photos.map((ph) => ({ id: ph.id })),
        units: p.units.map((u) => ({
          id: u.id, name: u.name, capacity: u.capacity, description: u.description || null,
          photos: u.photos.map((ph) => ({ id: ph.id })),
          fromNightlyCents: fromNightlyCents(u.pricingGroup),
          hasPricing: !!u.pricingGroupId,
        })),
      },
    });
  } catch (e) { next(e); }
});

// GET /public/units/:unitId/calendar?from=&to= — confirmed booked ranges (to grey out)
router.get('/units/:unitId/calendar', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    const unit = await prisma.unit.findFirst({ where: { id: req.params.unitId, property: { hostId } }, select: { id: true } });
    if (!unit) return res.status(404).json({ error: 'not_found' });
    const from = req.query.from ? dateOnly(req.query.from) : new Date();
    const to = req.query.to ? dateOnly(req.query.to) : new Date(Date.now() + 365 * 864e5);
    const bookings = await prisma.booking.findMany({
      where: { unitId: unit.id, status: 'confirmed', checkOut: { gt: from }, checkIn: { lt: to } },
      select: { checkIn: true, checkOut: true },
      orderBy: { checkIn: 'asc' },
    });
    res.json({ booked: bookings.map((b) => ({ checkIn: iso(b.checkIn), checkOut: iso(b.checkOut) })) });
  } catch (e) { next(e); }
});

// POST /public/quote — { unitId, checkIn, checkOut }
router.post('/quote', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    const { unitId, checkIn, checkOut } = req.body || {};
    if (!unitId || !checkIn || !checkOut) return res.status(400).json({ error: 'unitId_dates_required' });
    const unit = await prisma.unit.findFirst({ where: { id: unitId, property: { hostId } }, include: { pricingGroup: true } });
    if (!unit) return res.status(404).json({ error: 'not_found' });
    if (!unit.pricingGroup) return res.status(400).json({ error: 'no_pricing', message: 'This unit has no online pricing — please call to book.' });
    const q = quote(unit.pricingGroup, { checkIn: iso(checkIn), checkOut: iso(checkOut), cleans: 1 });
    if (!q) return res.status(400).json({ error: 'invalid_dates' });
    res.json({ quote: q });
  } catch (e) { next(e); }
});

// POST /public/book — validate the calendar is free + price, then create a
// confirmed website booking (blocks the calendar in the admin app too).
router.post('/book', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    const b = req.body || {};
    if (!b.unitId || !b.checkIn || !b.checkOut) return res.status(400).json({ error: 'unitId_dates_required' });
    if (!b.guestName || !(b.guestEmail || b.guestPhone)) {
      return res.status(400).json({ error: 'guest_contact_required', message: 'Please give your name and an email or phone number.' });
    }
    const unit = await prisma.unit.findFirst({ where: { id: b.unitId, property: { hostId } }, include: { pricingGroup: true, property: true } });
    if (!unit) return res.status(404).json({ error: 'not_found' });
    if (!unit.pricingGroup) return res.status(400).json({ error: 'no_pricing', message: 'This unit has no online pricing — please call to book.' });

    // The calendar must be free — re-checked right before we create the booking.
    const avail = await checkAvailability(unit.id, iso(b.checkIn), iso(b.checkOut), null);
    if (avail.error) return res.status(400).json({ error: avail.error });
    if (!avail.available) {
      return res.status(409).json({ error: 'dates_unavailable', message: 'Sorry — those dates were just taken. Please choose different dates.' });
    }

    const q = quote(unit.pricingGroup, { checkIn: iso(b.checkIn), checkOut: iso(b.checkOut), cleans: 1 });
    if (!q) return res.status(400).json({ error: 'invalid_dates' });

    const contact = [b.guestEmail, b.guestPhone].filter(Boolean).join(' · ');
    const comments = `Website booking · Contact: ${contact} · Guests: ${b.guests || '—'} · Quoted total R${(q.totalCents / 100).toFixed(2)}${b.message ? ` · Note: ${b.message}` : ''}`;

    const booking = await prisma.booking.create({
      data: {
        unitId: unit.id, hostId: unit.property.hostId, source: 'website', status: 'confirmed',
        guestName: b.guestName,
        checkIn: dateOnly(iso(b.checkIn)), checkOut: dateOnly(iso(b.checkOut)),
        comments, paymentStatus: 'unpaid',
      },
    });
    res.status(201).json({
      booking: { id: booking.id, checkIn: iso(booking.checkIn), checkOut: iso(booking.checkOut) },
      quote: q, property: unit.property.name, unit: unit.name,
    });
  } catch (e) { next(e); }
});

module.exports = router;
