// Public (no-auth) API for the SimonStays shopfront booking site.
// Reuses the same availability + pricing engines as the admin app, so a public
// booking is priced and blocked identically and lands in the same calendar.

const express = require('express');
const prisma = require('../lib/prisma');
const { checkAvailability } = require('../utils/sync');
const { dateOnly } = require('../utils/ical');
const { quote } = require('../utils/pricing');
const payments = require('../utils/payments');
const locks = require('../utils/locks');

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

// GET /public/host — who hosts this shopfront ("Hosted by …") + profile photo.
router.get('/host', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    if (!hostId) return res.json({ host: null });
    const h = await prisma.host.findUnique({ where: { id: hostId }, select: { name: true } });
    const photo = await prisma.photo.findFirst({ where: { hostId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    res.json({ host: { name: (h && h.name) || null, photoId: photo ? photo.id : null } });
  } catch (e) { next(e); }
});

// GET /public/properties?checkIn=&checkOut=&guests= — browse list.
// With dates, only properties with a free unit for that stay are returned, and
// stayFromCents is the cheapest available total for those dates.
router.get('/properties', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    if (!hostId) return res.json({ properties: [], filtered: false });
    const { checkIn, checkOut, guests } = req.query;
    const filtering = !!(checkIn && checkOut);
    const minGuests = guests ? Number(guests) : 0;

    const props = await prisma.property.findMany({
      where: { hostId },
      orderBy: { sortOrder: 'asc' },
      include: { photos: { orderBy: { sort: 'asc' } }, units: { include: unitInclude } },
    });

    const out = [];
    for (const p of props) {
      let units = p.units;
      if (minGuests) units = units.filter((u) => !u.capacity || u.capacity >= minGuests);
      if (units.length === 0) continue;

      let stayFromCents = null;
      if (filtering) {
        let anyFree = false;
        for (const u of units) {
          const av = await checkAvailability(u.id, iso(checkIn), iso(checkOut), null);
          if (!av.available) continue;
          anyFree = true;
          if (u.pricingGroup) {
            const q = quote(u.pricingGroup, { checkIn: iso(checkIn), checkOut: iso(checkOut), cleans: 1 });
            if (q && (stayFromCents == null || q.totalCents < stayFromCents)) stayFromCents = q.totalCents;
          }
        }
        if (!anyFree) continue; // no free room for these dates → hide it
      }

      const cover = p.photos[0] || p.units.flatMap((u) => u.photos)[0] || null;
      const fromCents = units.map((u) => fromNightlyCents(u.pricingGroup)).filter((v) => v != null);
      out.push({
        id: p.id, name: p.name, address: p.address || null, description: p.description || null,
        latitude: p.latitude ?? null, longitude: p.longitude ?? null,
        coverPhotoId: cover ? cover.id : null,
        maxCapacity: p.units.reduce((m, u) => Math.max(m, u.capacity || 0), 0),
        beds: p.units.reduce((m, u) => Math.max(m, u.bedrooms || 0), 0),
        fromNightlyCents: fromCents.length ? Math.min(...fromCents) : null,
        unitCount: units.length,
        stayFromCents, // cheapest total for the chosen dates (only when searching)
      });
    }
    res.json({ properties: out, filtered: filtering });
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
        latitude: p.latitude ?? null, longitude: p.longitude ?? null,
        photos: p.photos.map((ph) => ({ id: ph.id })),
        units: p.units.map((u) => ({
          id: u.id, name: u.name, capacity: u.capacity, description: u.description || null,
          bedrooms: u.bedrooms ?? null, bathrooms: u.bathrooms ?? null,
          // Guest-relevant amenities only — sensitive fields (wifi password,
          // smart-lock URL, access codes, lock battery) are deliberately omitted.
          checkInTime: u.checkInTime || null, checkOutTime: u.checkOutTime || null,
          access: u.access || null, security: u.security || null,
          backupPower: u.backupPower || null, backupWater: u.backupWater || null,
          parking: u.parkingNotes || null, wifi: u.wifiName ? true : false,
          photos: u.photos.map((ph) => ({ id: ph.id })),
          fromNightlyCents: fromNightlyCents(u.pricingGroup),
          hasPricing: !!u.pricingGroupId,
        })),
      },
    });
  } catch (e) { next(e); }
});

// GET /public/units?checkIn=&checkOut=&guests= — flat, unit-level browse. Each
// bookable unit is its own listing (with its complex's name/location). Duplicate
// unit records are de-duped by property+name (keeping the richest: most photos).
router.get('/units', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    if (!hostId) return res.json({ units: [], filtered: false });
    const { checkIn, checkOut, guests } = req.query;
    const filtering = !!(checkIn && checkOut);
    const minGuests = guests ? Number(guests) : 0;

    const props = await prisma.property.findMany({
      where: { hostId }, orderBy: { sortOrder: 'asc' },
      include: { photos: { orderBy: { sort: 'asc' } }, units: { include: unitInclude } },
    });

    // Collect candidate (real) units, de-duped by property + unit name.
    const best = new Map(); // key -> { unit, prop, photos }
    for (const p of props) {
      for (const u of p.units) {
        const nPhotos = (u.photos || []).length;
        if (!(u.pricingGroupId || nPhotos)) continue; // skip empty duplicate shells
        const key = p.id + '|' + (u.name || '');
        const prev = best.get(key);
        if (!prev || nPhotos > prev.nPhotos) best.set(key, { u, p, nPhotos });
      }
    }

    const out = [];
    for (const { u, p } of best.values()) {
      if (minGuests && u.capacity && u.capacity < minGuests) continue;
      let stayFromCents = null;
      if (filtering) {
        const av = await checkAvailability(u.id, iso(checkIn), iso(checkOut), null);
        if (!av.available) continue;
        if (u.pricingGroup) { const q = quote(u.pricingGroup, { checkIn: iso(checkIn), checkOut: iso(checkOut), cleans: 1 }); if (q) stayFromCents = q.totalCents; }
      }
      const cover = u.photos[0] || p.photos[0] || null;
      out.push({
        unitId: u.id, unitName: u.name, propertyId: p.id, propertyName: p.name,
        address: p.address || null, latitude: p.latitude ?? null, longitude: p.longitude ?? null,
        capacity: u.capacity, bedrooms: u.bedrooms ?? null, bathrooms: u.bathrooms ?? null,
        coverPhotoId: cover ? cover.id : null,
        fromNightlyCents: fromNightlyCents(u.pricingGroup), hasPricing: !!u.pricingGroupId,
        stayFromCents,
      });
    }
    res.json({ units: out, filtered: filtering });
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
    const overrides = await require('../utils/nightPrices').overridesFor(unit.id, iso(checkIn), iso(checkOut));
    const q = quote(unit.pricingGroup, { checkIn: iso(checkIn), checkOut: iso(checkOut), cleans: 1, overrides });
    if (!q) return res.status(400).json({ error: 'invalid_dates' });
    res.json({ quote: q });
  } catch (e) { next(e); }
});

// POST /public/book — create a PENDING hold (does NOT block the calendar). The
// calendar is only blocked once payment succeeds (POST /public/book/:id/pay).
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

    const avail = await checkAvailability(unit.id, iso(b.checkIn), iso(b.checkOut), null);
    if (avail.error) return res.status(400).json({ error: avail.error });
    if (!avail.available) {
      return res.status(409).json({ error: 'dates_unavailable', message: 'Sorry — those dates were just taken. Please choose different dates.' });
    }

    const bookOverrides = await require('../utils/nightPrices').overridesFor(unit.id, iso(b.checkIn), iso(b.checkOut));
    const q = quote(unit.pricingGroup, { checkIn: iso(b.checkIn), checkOut: iso(b.checkOut), cleans: 1, overrides: bookOverrides });
    if (!q) return res.status(400).json({ error: 'invalid_dates' });

    const contact = [b.guestEmail, b.guestPhone].filter(Boolean).join(' · ');
    const depoTxt = q.depositCents ? ` · Refundable deposit R${(q.depositCents / 100).toFixed(2)}` : '';
    const comments = `Website booking (awaiting payment) · Contact: ${contact} · Guests: ${b.guests || '—'} · Rental R${(q.rentalCents / 100).toFixed(2)}${depoTxt} · Payable R${(q.totalCents / 100).toFixed(2)}${b.message ? ` · Note: ${b.message}` : ''}`;

    const booking = await prisma.booking.create({
      data: {
        unitId: unit.id, hostId: unit.property.hostId, source: 'website', status: 'pending',
        guestName: b.guestName,
        checkIn: dateOnly(iso(b.checkIn)), checkOut: dateOnly(iso(b.checkOut)),
        comments, paymentStatus: 'unpaid',
        depositCents: q.depositCents || null, depositStatus: q.depositCents ? 'held' : null,
      },
    });
    const checkout = await payments.createCheckout(booking, q.totalCents);
    res.status(201).json({
      bookingId: booking.id, amountCents: q.totalCents, quote: q,
      property: unit.property.name, unit: unit.name,
      checkIn: iso(booking.checkIn), checkOut: iso(booking.checkOut),
      payment: checkout, // { mode:'simulate' } for now; { mode:'redirect', url } when a vendor is live
    });
  } catch (e) { next(e); }
});

// POST /public/book/:id/pay — confirm a pending booking once paid. In simulate
// mode this succeeds immediately; with a live vendor a validated webhook drives it.
router.post('/book/:id/pay', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, unit: { property: { hostId } } },
      include: { unit: { include: { property: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'not_found' });
    if (booking.status === 'confirmed') {
      return res.json({ confirmed: true, alreadyConfirmed: true, property: booking.unit.property.name, unit: booking.unit.name, booking: { id: booking.id, checkIn: iso(booking.checkIn), checkOut: iso(booking.checkOut) } });
    }
    if (booking.status !== 'pending') return res.status(400).json({ error: 'not_pending' });

    const paid = await payments.verifyPayment(booking, req.body);
    if (!paid.ok) return res.status(402).json({ error: 'payment_incomplete', message: paid.message || 'Payment not completed.' });

    // Re-check the calendar right before blocking it — the hold didn't reserve it.
    const avail = await checkAvailability(booking.unitId, iso(booking.checkIn), iso(booking.checkOut), booking.id);
    if (avail.error) return res.status(400).json({ error: avail.error });
    if (!avail.available) {
      return res.status(409).json({ error: 'dates_unavailable', message: 'Those dates were taken while paying — please contact us to sort out a refund.' });
    }

    const confirmed = await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'confirmed', paid: true, paymentStatus: 'paid' },
    });

    // Smart-lock guest code (RemoteLock / Yale via a unified provider) — stubbed
    // until credentials are set; returns null and never blocks confirmation.
    let accessCode = null;
    try { accessCode = await locks.issueGuestCode(confirmed, booking.unit); } catch (_) {}

    res.json({
      confirmed: true,
      booking: { id: confirmed.id, checkIn: iso(confirmed.checkIn), checkOut: iso(confirmed.checkOut) },
      property: booking.unit.property.name, unit: booking.unit.name,
      accessCode, // null until the smart-lock integration is live
    });
  } catch (e) { next(e); }
});

// ---- Public forms (guest damage reports + cleaner checkout reports) ----

// GET /public/forms/units — properties + units (with bed/bath) for the cleaner picker.
router.get('/forms/units', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    if (!hostId) return res.json({ properties: [], cleaners: [] });
    const [properties, providers, host] = await Promise.all([
      prisma.property.findMany({
        where: { hostId }, orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, units: { select: { id: true, name: true, bedrooms: true, bathrooms: true }, orderBy: { createdAt: 'asc' } } },
      }),
      prisma.serviceProvider.findMany({ where: { hostId, role: 'Cleaner' }, orderBy: { name: 'asc' }, select: { name: true } }),
      prisma.host.findUnique({ where: { id: hostId }, select: { cleaners: true } }),
    ]);
    const cleaners = providers.length ? providers.map((p) => p.name) : (Array.isArray(host?.cleaners) ? host.cleaners : []);
    res.json({ properties, cleaners });
  } catch (e) { next(e); }
});

// GET /public/forms/clean-for-unit/:unitId — the clean form that applies to this
// unit (by the form's unitIds), plus the unit's bedroom/bathroom counts so the
// page can repeat per-room questions.
router.get('/forms/clean-for-unit/:unitId', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    if (!hostId) return res.status(404).json({ error: 'not_available' });
    const unit = await prisma.unit.findFirst({
      where: { id: req.params.unitId, property: { hostId } },
      select: { id: true, name: true, bedrooms: true, bathrooms: true, capacity: true },
    });
    if (!unit) return res.status(404).json({ error: 'not_found' });
    const cleans = await prisma.formTemplate.findMany({ where: { hostId, type: 'clean', active: true } });
    let tpl = cleans.find((t) => Array.isArray(t.unitIds) && t.unitIds.includes(unit.id)) || cleans[0];
    if (!tpl) { const { defaultTemplate } = require('../utils/formDefaults'); tpl = { ...defaultTemplate('clean'), id: null, name: 'Checkout clean' }; }
    res.json({
      template: { id: tpl.id, name: tpl.name, title: tpl.title, description: tpl.description, fields: tpl.fields },
      unit,
    });
  } catch (e) { next(e); }
});

// GET /public/forms/:type — the active form definition + properties/units picker.
router.get('/forms/:type', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    if (!hostId) return res.status(404).json({ error: 'not_available' });
    const type = req.params.type;
    const { defaultTemplate, TYPES } = require('../utils/formDefaults');
    if (!TYPES.includes(type)) return res.status(404).json({ error: 'not_found' });
    let template = await prisma.formTemplate.findFirst({ where: { hostId, type, active: true } });
    if (!template) template = { ...defaultTemplate(type), id: null };
    const properties = await prisma.property.findMany({
      where: { hostId }, orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, units: { select: { id: true, name: true }, orderBy: { createdAt: 'asc' } } },
    });
    res.json({
      template: { id: template.id, type: template.type, title: template.title, description: template.description, fields: template.fields },
      properties,
    });
  } catch (e) { next(e); }
});

// POST /public/forms — create a submission (answers only). Photos are uploaded
// one at a time afterwards, so no single request is huge.
router.post('/forms', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    if (!hostId) return res.status(404).json({ error: 'not_available' });
    const b = req.body || {};
    const { TYPES } = require('../utils/formDefaults');
    if (!TYPES.includes(b.type)) return res.status(400).json({ error: 'invalid_type' });

    let propertyId = null, unitId = null;
    if (b.unitId) {
      const unit = await prisma.unit.findFirst({ where: { id: b.unitId, property: { hostId } }, select: { id: true, propertyId: true } });
      if (unit) { unitId = unit.id; propertyId = unit.propertyId; }
    } else if (b.propertyId) {
      const p = await prisma.property.findFirst({ where: { id: b.propertyId, hostId }, select: { id: true } });
      if (p) propertyId = p.id;
    }

    const submission = await prisma.formSubmission.create({
      data: {
        hostId, type: b.type, templateId: b.templateId || null,
        propertyId, unitId,
        submitterName: b.submitterName || null, submitterContact: b.submitterContact || null,
        answers: b.answers && typeof b.answers === 'object' ? b.answers : {},
        status: 'new',
      },
    });
    res.status(201).json({ ok: true, id: submission.id });
  } catch (e) { next(e); }
});

// POST /public/forms/:id/photos — attach one photo (base64) to a submission.
router.post('/forms/:id/photos', async (req, res, next) => {
  try {
    const hostId = await publicHostId();
    if (!hostId) return res.status(404).json({ error: 'not_available' });
    const sub = await prisma.formSubmission.findFirst({ where: { id: req.params.id, hostId }, select: { id: true } });
    if (!sub) return res.status(404).json({ error: 'not_found' });
    const img = decodeFormPhoto(req.body);
    if (!img) return res.status(400).json({ error: 'no_image' });
    // Transcode HEIC/HEIF (iPhone) to JPEG so it renders in every browser.
    const { toRenderable } = require('../utils/imagePrep');
    const out = await toRenderable(img.buffer, img.contentType);
    const photo = await prisma.photo.create({
      data: { formSubmissionId: sub.id, fieldId: req.body.fieldId || null, data: out.buffer, contentType: out.contentType, filename: req.body.filename || null },
      select: { id: true },
    });
    res.status(201).json({ id: photo.id });
  } catch (e) { next(e); }
});

// Recognise real image bytes by their magic number, so we never store a
// corrupt blob (e.g. an empty "data:," canvas result that decodes to 3 bytes).
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'image/heic'; // heic/heif family
  return null;
}

function decodeFormPhoto(body) {
  let { dataBase64, contentType } = body || {};
  if (!dataBase64) return null;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataBase64);
  if (m) { contentType = contentType || m[1]; dataBase64 = m[2]; }
  const buffer = Buffer.from(dataBase64, 'base64');
  // Reject anything that isn't a genuine image — this is what stopped the old
  // 3-byte "data:," uploads that rendered as broken thumbnails.
  const sniffed = sniffImage(buffer);
  if (!sniffed || buffer.length < 100) return null;
  return { buffer, contentType: sniffed || contentType || 'image/jpeg' };
}

module.exports = router;
