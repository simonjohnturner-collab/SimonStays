// GET /traffic?days=30 — how a host's own listings are doing on the shopfront:
// how often they appeared in search results, were opened, started checkout and
// were booked, per day and per listing, plus where those visitors came from and
// on what device. Counts only: who the visitors are stays with the platform
// admin (/admin/traffic). Visits by hosts signed in on that browser are left out.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

const n = (v) => Number(v || 0); // Postgres counts arrive as BigInt

router.get('/', async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 864e5);
    const units = await prisma.unit.findMany({ where: { property: { hostId: req.hostId } }, select: { id: true, name: true, property: { select: { id: true, name: true } } } });
    if (!units.length) return res.json({ days, empty: true, totals: {}, daily: [], listings: [], sources: [], devices: [] });
    const unitIds = units.map((u) => u.id);
    const q = (sql) => prisma.$queryRawUnsafe(sql, since, unitIds);
    // "at" is stored as UTC without a time zone: compare and group it as UTC.
    const W = `"at" >= ($1::timestamptz AT TIME ZONE 'UTC') AND "isHost" = false AND "unitId" = ANY($2::text[])`;

    const [totals] = await q(`SELECT
        COUNT(*) FILTER (WHERE type = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE type = 'view_listing') AS views,
        COUNT(DISTINCT "visitorId") FILTER (WHERE type = 'view_listing') AS viewers,
        COUNT(*) FILTER (WHERE type = 'start_checkout') AS checkouts,
        COUNT(*) FILTER (WHERE type IN ('booking_placed', 'request_sent')) AS bookings,
        COUNT(*) FILTER (WHERE type = 'enquiry_sent') AS enquiries
      FROM "PageEvent" WHERE ${W}`);
    const daily = await q(`SELECT to_char(date_trunc('day', ("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Johannesburg'), 'YYYY-MM-DD') AS day,
        COUNT(*) FILTER (WHERE type = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE type = 'view_listing') AS views,
        COUNT(DISTINCT "visitorId") FILTER (WHERE type = 'view_listing') AS viewers
      FROM "PageEvent" WHERE ${W} GROUP BY 1 ORDER BY 1`);
    const perUnit = await q(`SELECT "unitId",
        COUNT(*) FILTER (WHERE type = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE type = 'view_listing') AS views,
        COUNT(DISTINCT "visitorId") FILTER (WHERE type = 'view_listing') AS viewers,
        COUNT(*) FILTER (WHERE type = 'start_checkout') AS checkouts,
        COUNT(*) FILTER (WHERE type IN ('booking_placed', 'request_sent')) AS bookings
      FROM "PageEvent" WHERE ${W} GROUP BY "unitId"`);
    // Where the people who opened your listings came from, and on what device.
    const viewers = `"visitorId" IN (SELECT "visitorId" FROM "PageEvent" WHERE ${W} AND type = 'view_listing')`;
    const sources = await q(`SELECT COALESCE(NULLIF(source, ''), 'Direct / typed in') AS key, COUNT(DISTINCT "visitorId") AS visitors
      FROM "PageEvent" WHERE "at" >= ($1::timestamptz AT TIME ZONE 'UTC') AND ${viewers} GROUP BY 1 ORDER BY visitors DESC LIMIT 10`);
    const devices = await q(`SELECT COALESCE(device, 'unknown') AS key, COUNT(DISTINCT "visitorId") AS visitors
      FROM "PageEvent" WHERE "at" >= ($1::timestamptz AT TIME ZONE 'UTC') AND ${viewers} GROUP BY 1 ORDER BY visitors DESC`);

    const byUnit = Object.fromEntries(perUnit.map((r) => [r.unitId, r]));
    res.json({
      days,
      totals: Object.fromEntries(Object.entries(totals || {}).map(([k, v]) => [k, n(v)])),
      daily: daily.map((d) => ({ day: d.day, impressions: n(d.impressions), views: n(d.views), viewers: n(d.viewers) })),
      // Every listing, even with no traffic yet, busiest first.
      listings: units.map((u) => {
        const r = byUnit[u.id] || {};
        return { unitId: u.id, propertyId: u.property.id, name: `${u.property.name} · ${u.name}`, impressions: n(r.impressions), views: n(r.views), viewers: n(r.viewers), checkouts: n(r.checkouts), bookings: n(r.bookings) };
      }).sort((a, b) => b.views - a.views || b.impressions - a.impressions),
      sources: sources.map((r) => ({ key: r.key, visitors: n(r.visitors) })),
      devices: devices.map((r) => ({ key: r.key, visitors: n(r.visitors) })),
    });
  } catch (e) {
    if (/relation "PageEvent" does not exist/i.test(e.message)) return res.json({ empty: true, days: 0, totals: {}, daily: [], listings: [], sources: [], devices: [] });
    next(e);
  }
});

module.exports = router;
