// Pricing bubbles, host side. Every host sees every bubble (name, area, how many
// units and hosts, and its occupancy), but only the names of their own units in
// it. A host adds and removes their own units and sets their own rules; nobody
// can touch another host's units or prices. Only the creator can rename a
// bubble, or delete it once no other host has units in it.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const { occupancyDetail, adjustmentFor, cleanRules, todaySAST, eachNight } = require('../utils/bubbles');

const router = express.Router();
router.use(authHost);

const PREVIEW_DAYS = 14;
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const unitLabel = (u) => `${u.property.name} · ${u.name}`;

// GET /bubbles — every bubble, with this host's units, rules and the next two
// weeks' occupancy and price changes; plus this host's units, for adding.
router.get('/', async (req, res, next) => {
  try {
    const hostId = req.hostId;
    const [bubbles, myUnits] = await Promise.all([
      prisma.pricingBubble.findMany({ orderBy: { name: 'asc' }, include: { members: { include: { unit: { include: { property: { select: { name: true } } } } } }, rules: { where: { hostId } } } }),
      prisma.unit.findMany({ where: { property: { hostId } }, include: { property: { select: { name: true } }, bubbleMember: { include: { bubble: { select: { id: true, name: true } } } } }, orderBy: [{ property: { name: 'asc' } }, { name: 'asc' }] }),
    ]);
    const from = todaySAST(), to = addDays(from, PREVIEW_DAYS);
    const out = [];
    for (const b of bubbles) {
      const mine = b.members.filter((m) => m.hostId === hostId);
      const rule = b.rules[0] || null;
      const occ = await occupancyDetail(b.members.map((m) => m.unitId), from, to);
      out.push({
        id: b.id, name: b.name, area: b.area, description: b.description,
        createdByMe: b.createdByHostId === hostId,
        unitCount: b.members.length,
        hostCount: new Set(b.members.map((m) => m.hostId)).size,
        otherUnits: b.members.length - mine.length,
        myUnits: mine.map((m) => ({ unitId: m.unitId, label: unitLabel(m.unit) })),
        rule: rule ? { active: rule.active, surge: rule.surge, drops: rule.drops } : null,
        preview: eachNight(from, to).map((d) => { const o = occ[d] || { pct: 0, booked: 0, floating: 0, skipped: 0, units: b.members.length };
          return { date: d, occupancyPct: o.pct, booked: o.booked, floating: o.floating, skipped: o.skipped, units: o.units, adjustPct: rule ? adjustmentFor(rule, o.pct, d, from) : 0 }; }),
      });
    }
    res.json({
      bubbles: out,
      units: myUnits.map((u) => ({ id: u.id, label: unitLabel(u), bedrooms: u.bedrooms, bubbleId: u.bubbleMember ? u.bubbleMember.bubble.id : null, bubbleName: u.bubbleMember ? u.bubbleMember.bubble.name : null })),
    });
  } catch (e) { next(e); }
});

// POST /bubbles { name, area, description }
router.post('/', async (req, res, next) => {
  try {
    const name = clean((req.body || {}).name, 80);
    if (!name) return res.status(400).json({ error: 'name_required', message: 'Give the bubble a name, e.g. Rosebank 2-bed.' });
    const b = await prisma.pricingBubble.create({ data: { name, area: clean(req.body.area, 80) || null, description: clean(req.body.description, 300) || null, createdByHostId: req.hostId } });
    res.status(201).json({ bubble: b });
  } catch (e) { next(e); }
});

async function loadBubble(req, res) {
  const b = await prisma.pricingBubble.findUnique({ where: { id: String(req.params.id) }, include: { members: true } });
  if (!b) { res.status(404).json({ error: 'not_found', message: 'That bubble no longer exists.' }); return null; }
  return b;
}

// PATCH /bubbles/:id { name, area, description } — the creator only.
router.patch('/:id', async (req, res, next) => {
  try {
    const b = await loadBubble(req, res); if (!b) return;
    if (b.createdByHostId !== req.hostId) return res.status(403).json({ error: 'not_creator', message: 'Only the host who created this bubble can rename it.' });
    const body = req.body || {};
    const data = {};
    if ('name' in body) { data.name = clean(body.name, 80); if (!data.name) return res.status(400).json({ error: 'name_required' }); }
    if ('area' in body) data.area = clean(body.area, 80) || null;
    if ('description' in body) data.description = clean(body.description, 300) || null;
    res.json({ bubble: await prisma.pricingBubble.update({ where: { id: b.id }, data }) });
  } catch (e) { next(e); }
});

// DELETE /bubbles/:id — the creator, once no other host has units in it.
router.delete('/:id', async (req, res, next) => {
  try {
    const b = await loadBubble(req, res); if (!b) return;
    if (b.createdByHostId !== req.hostId) return res.status(403).json({ error: 'not_creator', message: 'Only the host who created this bubble can delete it.' });
    if (b.members.some((m) => m.hostId !== req.hostId)) return res.status(409).json({ error: 'in_use', message: 'Other hosts have units in this bubble, so it can’t be deleted. You can remove your own units instead.' });
    await prisma.pricingBubble.delete({ where: { id: b.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /bubbles/:id/units { unitId } — add one of this host's units.
router.post('/:id/units', async (req, res, next) => {
  try {
    const b = await loadBubble(req, res); if (!b) return;
    const unit = await prisma.unit.findFirst({ where: { id: String((req.body || {}).unitId || ''), property: { hostId: req.hostId } }, include: { bubbleMember: { include: { bubble: { select: { name: true } } } } } });
    if (!unit) return res.status(404).json({ error: 'unit_not_found', message: 'That unit isn’t one of yours.' });
    if (unit.bubbleMember) {
      if (unit.bubbleMember.bubbleId === b.id) return res.json({ ok: true });
      return res.status(409).json({ error: 'in_other_bubble', message: `That unit is already in “${unit.bubbleMember.bubble.name}”. Remove it there first.` });
    }
    await prisma.bubbleMember.create({ data: { bubbleId: b.id, unitId: unit.id, hostId: req.hostId } });
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /bubbles/:id/units/:unitId — take one of this host's units out.
router.delete('/:id/units/:unitId', async (req, res, next) => {
  try {
    const m = await prisma.bubbleMember.findUnique({ where: { unitId: String(req.params.unitId) } });
    if (!m || m.bubbleId !== String(req.params.id) || m.hostId !== req.hostId) return res.status(404).json({ error: 'not_found' });
    await prisma.bubbleMember.delete({ where: { id: m.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PUT /bubbles/:id/rules { active, surge: [...], drops: [...] } — this host's rules.
router.put('/:id/rules', async (req, res, next) => {
  try {
    const b = await loadBubble(req, res); if (!b) return;
    const r = cleanRules(req.body || {});
    const rule = await prisma.bubbleRule.upsert({
      where: { bubbleId_hostId: { bubbleId: b.id, hostId: req.hostId } },
      update: r, create: { bubbleId: b.id, hostId: req.hostId, ...r },
    });
    res.json({ rule: { active: rule.active, surge: rule.surge, drops: rule.drops } });
  } catch (e) { next(e); }
});

module.exports = router;
