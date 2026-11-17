// GET /admin/bubbles — every pricing bubble for the platform admin: who created
// it, every listing in it and its host, each host's rules (which hosts can't
// see of each other), and the next 14 nights' occupancy.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, requireAdmin } = require('../middleware/auth');
const { occupancyDetail, todaySAST, eachNight } = require('../utils/bubbles');
const { hostNames, listingsOf } = require('./bubbles');

const router = express.Router();
router.use(authHost, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const bubbles = await prisma.pricingBubble.findMany({
      orderBy: { name: 'asc' },
      include: { members: { include: { unit: { include: { property: { select: { name: true } } } } } }, rules: true },
    });
    const names = await hostNames(bubbles.flatMap((b) => [b.createdByHostId, ...b.members.map((m) => m.hostId), ...b.rules.map((r) => r.hostId)]));
    const from = todaySAST(), to = new Date(Date.parse(`${from}T12:00:00Z`) + 14 * 864e5).toISOString().slice(0, 10);
    const out = [];
    for (const b of bubbles) {
      const occ = await occupancyDetail(b.members.map((m) => m.unitId), from, to);
      out.push({
        id: b.id, name: b.name, area: b.area, createdBy: names[b.createdByHostId], createdAt: b.createdAt,
        listings: listingsOf(b, names, null),
        rules: b.rules.map((r) => ({ hostName: names[r.hostId], active: r.active, surge: r.surge, drops: r.drops, updatedAt: r.updatedAt })),
        preview: eachNight(from, to).map((d) => { const o = occ[d] || { pct: 0, booked: 0, floating: 0, skipped: 0, units: b.members.length }; return { date: d, ...o }; }),
      });
    }
    res.json({ bubbles: out });
  } catch (e) { next(e); }
});

module.exports = router;
