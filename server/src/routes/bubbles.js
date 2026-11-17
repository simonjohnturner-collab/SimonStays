// Pricing bubbles, host side. Every host sees every bubble: its occupancy and
// every listing in it, with who hosts it and a link to the public listing, so
// members can check the bubble is like-for-like and ask a host to take a
// listing out (POST …/units/:unitId/flag). Each host's rules stay private. A
// host adds and removes their own units and sets their own rules; nobody can
// touch another host's units or prices. Only the creator can rename a bubble,
// or delete it once no other host has units in it.
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
const SHOP = () => (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
// Each host's display name: their name, or their company's.
async function hostNames(ids) {
  const list = [...new Set(ids)];
  const [hosts, billers] = await Promise.all([
    prisma.host.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }),
    prisma.billerProfile.findMany({ where: { hostId: { in: list } }, select: { hostId: true, companyName: true } }),
  ]);
  const co = Object.fromEntries(billers.map((b) => [b.hostId, b.companyName]));
  return Object.fromEntries(list.map((id) => { const h = hosts.find((x) => x.id === id); return [id, (h && h.name) || co[id] || 'A host']; }));
}
// Every listing in a bubble, as other members see it.
const listingsOf = (b, names, hostId) => b.members.map((m) => ({
  unitId: m.unitId, label: unitLabel(m.unit), bedrooms: m.unit.bedrooms, sleeps: m.unit.capacity,
  hostName: names[m.hostId], mine: m.hostId === hostId,
  url: `${SHOP()}/stays/${m.unit.propertyId}/${m.unitId}`,
})).sort((x, y) => (y.mine - x.mine) || x.label.localeCompare(y.label));

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
    const names = await hostNames(bubbles.flatMap((b) => b.members.map((m) => m.hostId)));
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
        listings: listingsOf(b, names, hostId),
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

// POST /bubbles/:id/units/:unitId/flag { reason } — ask the host of another
// listing in the bubble to take it out (e.g. it isn't like-for-like). Emails
// that host, copied to SimonStays support. At most once a day per listing.
const flagged = new Map(); // `${hostId}:${unitId}` -> time
router.post('/:id/units/:unitId/flag', async (req, res, next) => {
  try {
    const m = await prisma.bubbleMember.findUnique({ where: { unitId: String(req.params.unitId) }, include: { bubble: true, unit: { include: { property: { select: { name: true } } } } } });
    if (!m || m.bubbleId !== String(req.params.id)) return res.status(404).json({ error: 'not_found' });
    if (m.hostId === req.hostId) return res.status(400).json({ error: 'own_unit', message: 'That’s your own listing: take it out with × instead.' });
    const key = `${req.hostId}:${m.unitId}`;
    if (flagged.get(key) > Date.now() - 864e5) return res.status(429).json({ error: 'already_asked', message: 'You’ve already asked about this listing today.' });
    const reason = clean((req.body || {}).reason, 600);
    if (!reason) return res.status(400).json({ error: 'reason_required', message: 'Say why it doesn’t fit, so the host can decide.' });
    const [owner, asker] = await Promise.all([
      prisma.host.findUnique({ where: { id: m.hostId }, select: { email: true, name: true } }),
      hostNames([req.hostId]),
    ]);
    if (!owner || !owner.email) return res.status(400).json({ error: 'no_email', message: 'That host can’t be emailed. Please contact support@simonstays.co.za.' });
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const listing = unitLabel(m.unit), who = asker[req.hostId];
    const text = `Hi ${owner.name || 'there'},

${who}, who also has listings in the pricing bubble “${m.bubble.name}”, has asked whether ${listing} belongs in it:

“${reason}”

Bubble prices follow how full similar places are, so it works best when every listing is like-for-like. If you agree, open Menu → Pricing bubbles in SimonStays and take ${listing} out of “${m.bubble.name}” (the × next to it). If you think it fits, there’s nothing to do.

SimonStays`;
    await require('../utils/mailer').sendMail({
      to: [owner.email, 'support@simonstays.co.za'],
      subject: `Pricing bubble “${m.bubble.name}”: is ${listing} a good fit?`,
      text, html: `<div style="font-family:sans-serif;line-height:1.55;max-width:560px">${esc(text).split(String.fromCharCode(10)).join('<br>')}</div>`,
    });
    flagged.set(key, Date.now());
    res.json({ ok: true, message: `We’ve emailed the host of ${listing} your note.` });
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
module.exports.hostNames = hostNames;
module.exports.listingsOf = listingsOf;
