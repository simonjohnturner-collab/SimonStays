const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, requireOwnedProperty, requireOwnedUnit } = require('../middleware/auth');
const { syncUnit } = require('../utils/sync');
const { quote } = require('../utils/pricing');

const router = express.Router();
router.use(authHost);

// POST /units { propertyId, name, capacity }
router.post('/', async (req, res) => {
  const { propertyId, name, capacity } = req.body || {};
  if (!propertyId || !name) return res.status(400).json({ error: 'propertyId_and_name_required' });
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property || property.hostId !== req.hostId) return res.status(403).json({ error: 'forbidden' });
  const unit = await prisma.unit.create({
    data: { propertyId, name, capacity: capacity != null ? Number(capacity) : null },
  });
  res.status(201).json({ unit });
});

// GET /units/:id — one unit with channels + feed URL.
router.get('/:id', requireOwnedUnit, async (req, res) => {
  res.json({ unit: withFeedUrl(req.unit, req) });
});

// PATCH /units/:id { name, capacity, pricingGroupId }
router.patch('/:id', requireOwnedUnit, async (req, res) => {
  const b = req.body || {};
  const data = {
    name: b.name ?? req.unit.name,
    capacity: b.capacity != null ? Number(b.capacity) : req.unit.capacity,
  };
  if ('description' in b) data.description = b.description;
  if ('bedrooms' in b) data.bedrooms = b.bedrooms === '' || b.bedrooms == null ? null : Number(b.bedrooms);
  if ('bathrooms' in b) data.bathrooms = b.bathrooms === '' || b.bathrooms == null ? null : Number(b.bathrooms);
  if ('wifiName' in b) data.wifiName = b.wifiName === '' ? null : b.wifiName;
  if ('wifiPassword' in b) data.wifiPassword = b.wifiPassword === '' ? null : b.wifiPassword;
  ['checkInTime', 'checkOutTime', 'security', 'access', 'accessMethod', 'smartLockUrl', 'backupPower', 'backupWater', 'parkingNotes']
    .forEach((k) => { if (k in b) data[k] = b[k] === '' ? null : b[k]; });
  if ('parkingBays' in b) data.parkingBays = (b.parkingBays === '' || b.parkingBays == null) ? null : Number(b.parkingBays);
  if ('lockBattery' in b) data.lockBattery = (b.lockBattery === '' || b.lockBattery == null) ? null : Number(b.lockBattery);
  if ('pricingGroupId' in b) {
    if (b.pricingGroupId) {
      const g = await prisma.pricingGroup.findUnique({ where: { id: b.pricingGroupId } });
      if (!g || g.hostId !== req.hostId) return res.status(400).json({ error: 'invalid_group' });
      data.pricingGroupId = b.pricingGroupId;
    } else data.pricingGroupId = null;
  }
  const unit = await prisma.unit.update({ where: { id: req.unit.id }, data });
  res.json({ unit });
});

// DELETE /units/:id
router.delete('/:id', requireOwnedUnit, async (req, res) => {
  await prisma.unit.delete({ where: { id: req.unit.id } });
  res.json({ ok: true });
});

// GET /units/:id/bookings?from=ISO&to=ISO
router.get('/:id/bookings', requireOwnedUnit, async (req, res) => {
  const { from, to } = req.query;
  const where = { unitId: req.unit.id, status: { not: 'cancelled' } };
  if (from) where.checkOut = { gte: new Date(from) };
  if (to) where.checkIn = { lte: new Date(to) };
  const bookings = await prisma.booking.findMany({ where, orderBy: { checkIn: 'asc' }, include: { cleans: true } });
  res.json({ bookings });
});

// GET /units/:id/night-rates?from=&to= — the effective nightly base for each
// date (rate-card nightly + flex, or a manual override), for the month view.
router.get('/:id/night-rates', requireOwnedUnit, async (req, res) => {
  const { effectiveNightly } = require('../utils/pricing');
  const { dateOnly } = require('../utils/ical');
  const unit = await prisma.unit.findUnique({ where: { id: req.unit.id }, include: { pricingGroup: true } });
  const rc = unit.pricingGroup;
  const from = req.query.from ? new Date(req.query.from + 'T00:00:00Z') : new Date();
  const to = req.query.to ? new Date(req.query.to + 'T00:00:00Z') : new Date(Date.now() + 62 * 864e5);
  const rows = await prisma.nightPrice.findMany({ where: { unitId: unit.id, date: { gte: dateOnly(from.toISOString().slice(0, 10)), lte: dateOnly(to.toISOString().slice(0, 10)) } } });
  const ov = {}; rows.forEach((r) => { ov[r.date.toISOString().slice(0, 10)] = r.priceCents; });
  const nights = [];
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (rc) { const e = effectiveNightly(rc, new Date(iso + 'T12:00:00Z'), ov); nights.push({ date: iso, cents: e.cents, baseCents: e.baseCents, overridden: e.overridden, flexPercent: e.flexPercent, weekend: e.weekend }); }
    else nights.push({ date: iso, cents: ov[iso] != null ? ov[iso] : null, overridden: ov[iso] != null, weekend: [5, 6].includes(new Date(iso + 'T12:00:00Z').getUTCDay()) });
  }
  res.json({ nights, hasPricing: !!rc });
});

// PUT /units/:id/night-prices — { dates:[ISO], priceCents } sets an override for
// those nights; priceCents null/'' clears them.
router.put('/:id/night-prices', requireOwnedUnit, async (req, res) => {
  const { dateOnly } = require('../utils/ical');
  const b = req.body || {};
  const dates = Array.isArray(b.dates) ? b.dates : [];
  if (!dates.length) return res.status(400).json({ error: 'dates_required' });
  const clear = b.priceCents == null || b.priceCents === '';
  const cents = clear ? null : Math.round(Number(b.priceCents));
  if (!clear && !(cents >= 0)) return res.status(400).json({ error: 'invalid_price' });
  for (const ds of dates) {
    const date = dateOnly(String(ds).slice(0, 10));
    if (clear) await prisma.nightPrice.deleteMany({ where: { unitId: req.unit.id, date } });
    else await prisma.nightPrice.upsert({ where: { unitId_date: { unitId: req.unit.id, date } }, update: { priceCents: cents }, create: { unitId: req.unit.id, date, priceCents: cents } });
  }
  res.json({ ok: true, count: dates.length, cleared: clear });
});

// POST /units/:id/sync — pull this unit's channel calendars now.
router.post('/:id/sync', requireOwnedUnit, async (req, res) => {
  try {
    const summary = await syncUnit(req.unit.id);
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ error: 'sync_failed', message: e.message });
  }
});

// PUT /units/:id/calendar { importUrl } — set/replace the unit's single iCal
// import link (simplified one-channel model). Blank clears it.
router.put('/:id/calendar', requireOwnedUnit, async (req, res) => {
  const importUrl = (req.body?.importUrl || '').trim();
  const existing = (req.unit.channels || [])[0];
  if (!importUrl) {
    if (existing) await prisma.channelConnection.delete({ where: { id: existing.id } });
    return res.json({ channel: null });
  }
  // Guard: the same Airbnb calendar link must not be used by two units, or one
  // unit's calendar gets mirrored onto another. Reject a link already in use.
  const clash = await prisma.channelConnection.findFirst({
    where: {
      importUrl,
      unitId: { not: req.unit.id },
      unit: { property: { hostId: req.unit.property.hostId } },
    },
    include: { unit: { include: { property: true } } },
  });
  if (clash) {
    return res.status(409).json({
      error: 'duplicate_import_url',
      message: `That calendar link is already used by ${clash.unit.property.name} · ${clash.unit.name}. Each unit needs its own Airbnb calendar link.`,
    });
  }
  const channel = existing
    ? await prisma.channelConnection.update({ where: { id: existing.id }, data: { importUrl } })
    : await prisma.channelConnection.create({ data: { unitId: req.unit.id, type: 'airbnb', importUrl } });
  res.json({ channel });
});

// POST /units/:id/quote — price from the unit's pricing group.
router.post('/:id/quote', requireOwnedUnit, async (req, res) => {
  if (!req.unit.pricingGroupId) return res.status(404).json({ error: 'no_rate_card' });
  const g = await prisma.pricingGroup.findUnique({ where: { id: req.unit.pricingGroupId } });
  if (!g) return res.status(404).json({ error: 'no_rate_card' });
  const body = req.body || {};
  let overrides = null;
  if (body.checkIn && body.checkOut) {
    const { overridesFor } = require('../utils/nightPrices');
    overrides = await overridesFor(req.unit.id, String(body.checkIn).slice(0, 10), String(body.checkOut).slice(0, 10));
  }
  const q = quote(g, { ...body, overrides });
  if (!q) return res.status(400).json({ error: 'invalid_dates' });
  res.json({ quote: q });
});

function withFeedUrl(unit, req) {
  // Prefer an explicit PUBLIC_BASE_URL; otherwise derive from the request host
  // (so the feed link is always the public https:// URL the app is served on).
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return { ...unit, feedUrl: `${base}/feed/${unit.id}.ics?token=${unit.publishToken}` };
}

module.exports = router;
