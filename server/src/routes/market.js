// Competitor market intelligence — the "building fill" gauge.
//
// Lets a host register the other operators in their building (e.g. CAG at The
// Vantage), probe their live booking engine, and read back an occupancy proxy +
// price curve to chart their own pricing against. All routes are host-scoped.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const marketProbe = require('../utils/marketProbe');

const router = express.Router();
router.use(authHost);

// Fields a host may set on a competitor.
function competitorInput(b = {}) {
  const out = {};
  if (typeof b.name === 'string') out.name = b.name.trim();
  if (typeof b.building === 'string') out.building = b.building.trim() || null;
  if (typeof b.source === 'string' && ['SITEMINDER_TBB', 'OTA', 'MANUAL'].includes(b.source)) out.source = b.source;
  if (typeof b.channelCode === 'string') out.channelCode = b.channelCode.trim() || null;
  if (typeof b.apiBase === 'string') out.apiBase = b.apiBase.trim() || null;
  if (typeof b.currency === 'string') out.currency = b.currency.trim() || 'ZAR';
  if (b.unitCounts && typeof b.unitCounts === 'object' && !Array.isArray(b.unitCounts)) out.unitCounts = b.unitCounts;
  if (typeof b.active === 'boolean') out.active = b.active;
  if (typeof b.notes === 'string') out.notes = b.notes;
  return out;
}

async function requireOwnedCompetitor(req, res, next) {
  const c = await prisma.competitor.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).json({ error: 'competitor_not_found' });
  if (c.hostId !== req.hostId) return res.status(403).json({ error: 'forbidden' });
  req.competitor = c;
  next();
}

// GET /market/competitors — the host's tracked operators.
router.get('/competitors', async (req, res) => {
  const competitors = await prisma.competitor.findMany({
    where: { hostId: req.hostId },
    orderBy: [{ building: 'asc' }, { name: 'asc' }],
  });
  res.json({ competitors });
});

// POST /market/competitors — register an operator to track.
router.post('/competitors', async (req, res) => {
  const data = competitorInput(req.body);
  if (!data.name) return res.status(400).json({ error: 'name_required' });
  if (data.source === 'SITEMINDER_TBB' && !data.channelCode) {
    return res.status(400).json({ error: 'channelCode_required_for_tbb' });
  }
  const competitor = await prisma.competitor.create({ data: { hostId: req.hostId, ...data } });
  res.status(201).json({ competitor });
});

// PATCH /market/competitors/:id — edit (unit counts, active, channel, etc.).
router.patch('/competitors/:id', requireOwnedCompetitor, async (req, res) => {
  const competitor = await prisma.competitor.update({ where: { id: req.competitor.id }, data: competitorInput(req.body) });
  res.json({ competitor });
});

// DELETE /market/competitors/:id — stop tracking (also removes its snapshots).
router.delete('/competitors/:id', requireOwnedCompetitor, async (req, res) => {
  await prisma.competitor.delete({ where: { id: req.competitor.id } });
  res.json({ ok: true });
});

// POST /market/competitors/:id/probe — run a probe now. Fire-and-forget so the
// request returns immediately; results land in MarketSnapshot as it runs.
router.post('/competitors/:id/probe', requireOwnedCompetitor, async (req, res) => {
  const days = Math.min(Number(req.body?.days) || marketProbe.config().windowDays, 90);
  if (req.competitor.source !== 'SITEMINDER_TBB') {
    return res.status(400).json({ error: 'probe_only_supports_tbb' });
  }
  marketProbe
    .probeCompetitor(req.competitor, { days })
    .then((s) => console.log(`[market] probe done: ${JSON.stringify({ competitor: s.competitor, rows: s.rows, available: s.available, errors: s.errors })}`))
    .catch((e) => console.error(`[market] probe failed for ${req.competitor.name}: ${e.message}`));
  res.status(202).json({ started: true, competitor: req.competitor.name, days });
});

// ---- occupancy aggregation (feeds the chart) ----

// Occupancy proxy for one stay-date from its latest snapshots. The signal is
// per-room-type: a room type with no bookable quote is treated as occupied. Where
// we know a room type's unit count we weight by it (a fully-booked large room type
// counts more); otherwise every room type weighs equally. This is a floor on true
// occupancy — a room type still counts as "available" while even one unit is free —
// but it moves with the market, which is what the pricing chart needs.
function occupancyForDate(rows, unitCounts) {
  let occW = 0, totW = 0;       // weighted by unit counts (or 1 each)
  let occSlots = 0, totSlots = 0;
  let priceSum = 0, priceN = 0;
  let weighted = false;
  for (const r of rows) {
    const w = Number(unitCounts?.[r.roomType]);
    const weight = Number.isFinite(w) && w > 0 ? w : 1;
    if (Number.isFinite(w) && w > 0) weighted = true;
    const occ = r.available ? 0 : 1; // room type fully unavailable = occupied
    occW += weight * occ; totW += weight;
    occSlots += occ; totSlots += 1;
    if (r.available && r.priceCents != null) { priceSum += r.priceCents; priceN += 1; }
  }
  const occupancyPct = totW > 0 ? occW / totW : null;
  return {
    occupancyPct: occupancyPct == null ? null : Math.round(occupancyPct * 1000) / 1000,
    basis: weighted ? 'weighted' : 'slots',
    roomTypes: totSlots,
    roomTypesAvailable: totSlots - occSlots,
    avgPriceCents: priceN ? Math.round(priceSum / priceN) : null,
  };
}

// GET /market/occupancy?competitorId=&days=30
// Forward availability + price curve from the most recent capture run: for each
// upcoming night, how full the operator is and the average quoted price.
router.get('/occupancy', async (req, res) => {
  const competitor = await prisma.competitor.findFirst({
    where: req.query.competitorId
      ? { id: String(req.query.competitorId), hostId: req.hostId }
      : { hostId: req.hostId, source: 'SITEMINDER_TBB', active: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!competitor) return res.status(404).json({ error: 'no_competitor' });

  // Latest capture bucket for this competitor.
  const latest = await prisma.marketSnapshot.findFirst({
    where: { competitorId: competitor.id },
    orderBy: { capturedDate: 'desc' },
    select: { capturedDate: true },
  });
  if (!latest) return res.json({ competitor: pub(competitor), capturedDate: null, days: [], byRoomType: [] });

  const days = Math.min(Number(req.query.days) || marketProbe.config().windowDays, 120);
  const horizon = new Date(); horizon.setUTCDate(horizon.getUTCDate() + days);
  const snaps = await prisma.marketSnapshot.findMany({
    where: { competitorId: competitor.id, capturedDate: latest.capturedDate, stayDate: { lte: horizon } },
    orderBy: { stayDate: 'asc' },
  });

  const unitCounts = competitor.unitCounts || {};
  // group by stayDate
  const byDate = new Map();
  for (const s of snaps) {
    const key = s.stayDate.toISOString().slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(s);
  }
  const daysOut = [...byDate.entries()].map(([date, rows]) => ({ date, ...occupancyForDate(rows, unitCounts) }));

  // current price + availability per room type (nearest upcoming night)
  const byRoomType = summariseByRoomType(snaps, unitCounts);

  res.json({
    competitor: pub(competitor),
    capturedDate: latest.capturedDate.toISOString().slice(0, 10),
    windowDays: days,
    days: daysOut,
    byRoomType,
  });
});

// GET /market/prices?competitorId=&days=30
// The latest capture run's forward price series, grouped by room type — the feed
// for the price chart. Each room type carries a per-night [{date, priceCents,
// promoPriceCents}] series (standard + promotional rate).
router.get('/prices', async (req, res) => {
  const competitor = await prisma.competitor.findFirst({
    where: req.query.competitorId
      ? { id: String(req.query.competitorId), hostId: req.hostId }
      : { hostId: req.hostId, source: 'SITEMINDER_TBB', active: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!competitor) return res.status(404).json({ error: 'no_competitor' });

  const latest = await prisma.marketSnapshot.findFirst({
    where: { competitorId: competitor.id },
    orderBy: { capturedDate: 'desc' },
    select: { capturedDate: true },
  });
  if (!latest) return res.json({ competitor: pub(competitor), capturedDate: null, roomTypes: [] });

  const days = Math.min(Number(req.query.days) || marketProbe.config().windowDays, 120);
  const horizon = new Date(); horizon.setUTCDate(horizon.getUTCDate() + days);
  const snaps = await prisma.marketSnapshot.findMany({
    where: { competitorId: competitor.id, capturedDate: latest.capturedDate, stayDate: { lte: horizon } },
    orderBy: { stayDate: 'asc' },
  });

  const unitCounts = competitor.unitCounts || {};
  const byRT = new Map();
  for (const s of snaps) {
    if (!byRT.has(s.roomType)) byRT.set(s.roomType, []);
    byRT.get(s.roomType).push({
      date: s.stayDate.toISOString().slice(0, 10),
      priceCents: s.priceCents,
      promoPriceCents: s.promoPriceCents,
    });
  }
  const roomTypes = [...byRT.entries()].map(([roomType, series]) => ({
    roomType,
    unitCount: Number(unitCounts?.[roomType]) || null,
    series,
  }));
  res.json({ competitor: pub(competitor), capturedDate: latest.capturedDate.toISOString().slice(0, 10), currency: competitor.currency, roomTypes });
});

// GET /market/trend?competitorId=&days=60
// How the building's fill has moved over successive capture runs — average
// occupancy across the forward window, per capture day. Fills in as data
// accumulates (one point per day the probe runs).
router.get('/trend', async (req, res) => {
  const competitor = await prisma.competitor.findFirst({
    where: req.query.competitorId
      ? { id: String(req.query.competitorId), hostId: req.hostId }
      : { hostId: req.hostId, source: 'SITEMINDER_TBB', active: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!competitor) return res.status(404).json({ error: 'no_competitor' });

  const since = new Date(); since.setUTCDate(since.getUTCDate() - (Math.min(Number(req.query.days) || 60, 365)));
  const snaps = await prisma.marketSnapshot.findMany({
    where: { competitorId: competitor.id, capturedDate: { gte: since } },
    orderBy: { capturedDate: 'asc' },
  });
  const unitCounts = competitor.unitCounts || {};
  const byCapture = new Map();
  for (const s of snaps) {
    const key = s.capturedDate.toISOString().slice(0, 10);
    if (!byCapture.has(key)) byCapture.set(key, []);
    byCapture.get(key).push(s);
  }
  const points = [...byCapture.entries()].map(([capturedDate, rows]) => {
    const o = occupancyForDate(rows, unitCounts);
    return { capturedDate, occupancyPct: o.occupancyPct, basis: o.basis, avgPriceCents: o.avgPriceCents };
  });
  res.json({ competitor: pub(competitor), points });
});

function summariseByRoomType(snaps, unitCounts) {
  const byRT = new Map();
  for (const s of snaps) {
    if (!byRT.has(s.roomType)) byRT.set(s.roomType, []);
    byRT.get(s.roomType).push(s);
  }
  return [...byRT.entries()].map(([roomType, rows]) => {
    rows.sort((a, b) => a.stayDate - b.stayDate);
    const priced = rows.filter((r) => r.priceCents != null).map((r) => r.priceCents).sort((a, b) => a - b);
    const nightsAvailable = rows.filter((r) => r.available).length;
    return {
      roomType,
      unitCount: Number(unitCounts?.[roomType]) || null,
      nights: rows.length,
      nightsAvailable,
      availabilityPct: rows.length ? Math.round((nightsAvailable / rows.length) * 1000) / 1000 : null,
      medianPriceCents: priced.length ? priced[Math.floor(priced.length / 2)] : null,
      minPriceCents: priced.length ? priced[0] : null,
      maxPriceCents: priced.length ? priced[priced.length - 1] : null,
    };
  });
}

function pub(c) {
  return { id: c.id, name: c.name, building: c.building, source: c.source, currency: c.currency, unitCounts: c.unitCounts };
}

module.exports = router;
