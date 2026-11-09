// GET /admin/traffic?days=30&hosts=0 — the site's traffic for the platform admin:
// visitors, sessions, page views, the booking funnel, how each listing performs
// (impressions → views → checkouts → bookings), what people click and search,
// where they come from and on what device. From PageEvent (routes/track.js).
// Visits by hosts signed in on that browser are left out unless hosts=1.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authHost, requireAdmin);

const n = (v) => Number(v || 0); // Postgres counts arrive as BigInt

router.get('/', async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 864e5);
    const hosts = req.query.hosts === '1';
    const hostCond = hosts ? '' : 'AND "isHost" = false';
    const q = (sql, ...args) => prisma.$queryRawUnsafe(sql, since, ...args);
    // "at" is stored as UTC without a time zone: compare and group it as UTC.
    const W = `"at" >= ($1::timestamptz AT TIME ZONE 'UTC') ${hostCond}`;

    const [totals] = await q(`SELECT
        COUNT(DISTINCT "visitorId") AS visitors, COUNT(DISTINCT "sessionId") AS sessions,
        COUNT(*) FILTER (WHERE type = 'pageview') AS pageviews,
        COUNT(*) FILTER (WHERE type = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE type = 'view_listing') AS listing_views,
        COUNT(*) FILTER (WHERE type = 'search') AS searches,
        COUNT(*) FILTER (WHERE type = 'start_checkout') AS checkouts,
        COUNT(*) FILTER (WHERE type = 'booked') AS booked,
        COUNT(*) FILTER (WHERE type = 'request_sent') AS requests,
        COUNT(*) FILTER (WHERE type = 'enquiry_sent') AS enquiries,
        COUNT(*) FILTER (WHERE type = 'signup') AS signups
      FROM "PageEvent" WHERE ${W}`);

    const daily = await q(`SELECT to_char(date_trunc('day', ("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Johannesburg'), 'YYYY-MM-DD') AS day,
        COUNT(DISTINCT "visitorId") AS visitors, COUNT(*) FILTER (WHERE type = 'pageview') AS pageviews,
        COUNT(*) FILTER (WHERE type = 'view_listing') AS listing_views
      FROM "PageEvent" WHERE ${W} GROUP BY 1 ORDER BY 1`);

    const [funnel] = await q(`SELECT
        COUNT(DISTINCT "visitorId") AS visited,
        COUNT(DISTINCT "visitorId") FILTER (WHERE type = 'search') AS searched,
        COUNT(DISTINCT "visitorId") FILTER (WHERE type = 'view_listing') AS viewed,
        COUNT(DISTINCT "visitorId") FILTER (WHERE type = 'start_checkout') AS checkout,
        COUNT(DISTINCT "visitorId") FILTER (WHERE type IN ('booked', 'booking_placed', 'request_sent')) AS booked
      FROM "PageEvent" WHERE ${W}`);

    const listingRows = await q(`SELECT "unitId",
        COUNT(*) FILTER (WHERE type = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE type = 'view_listing') AS views,
        COUNT(DISTINCT "visitorId") FILTER (WHERE type = 'view_listing') AS viewers,
        COUNT(*) FILTER (WHERE type = 'start_checkout') AS checkouts,
        COUNT(*) FILTER (WHERE type IN ('booking_placed', 'request_sent')) AS bookings
      FROM "PageEvent" WHERE ${W} AND "unitId" IS NOT NULL GROUP BY "unitId" ORDER BY views DESC, impressions DESC LIMIT 50`);
    const units = listingRows.length ? await prisma.unit.findMany({ where: { id: { in: listingRows.map((r) => r.unitId) } }, select: { id: true, name: true, property: { select: { name: true } } } }) : [];
    const nameOf = Object.fromEntries(units.map((u) => [u.id, [u.property && u.property.name, u.name && `Unit ${u.name}`].filter(Boolean).join(' · ')]));

    const top = (type, col = 'label', limit = 15) => q(`SELECT ${col} AS key, COUNT(*) AS count, COUNT(DISTINCT "visitorId") AS visitors
      FROM "PageEvent" WHERE ${W} AND type = '${type}' AND ${col} IS NOT NULL AND ${col} <> '' GROUP BY 1 ORDER BY count DESC LIMIT ${limit}`);
    const [clicks, searches, pages] = await Promise.all([top('click'), top('search'), top('pageview', 'path')]);
    const sources = await q(`SELECT COALESCE(NULLIF(source, ''), 'Direct / typed in') AS key, COUNT(DISTINCT "visitorId") AS visitors, COUNT(DISTINCT "sessionId") AS count
      FROM "PageEvent" WHERE ${W} GROUP BY 1 ORDER BY visitors DESC LIMIT 15`);
    const devices = await q(`SELECT COALESCE(device, 'unknown') AS key, COUNT(DISTINCT "visitorId") AS visitors, COUNT(DISTINCT "sessionId") AS count
      FROM "PageEvent" WHERE ${W} GROUP BY 1 ORDER BY visitors DESC`);
    const [live] = await prisma.$queryRawUnsafe(`SELECT COUNT(DISTINCT "visitorId") AS visitors FROM "PageEvent" WHERE "at" >= ($1::timestamptz AT TIME ZONE 'UTC') ${hostCond}`, new Date(Date.now() - 5 * 60000));
    const [returning] = await q(`SELECT COUNT(*) AS visitors FROM (SELECT "visitorId" FROM "PageEvent" WHERE ${W} GROUP BY 1 HAVING COUNT(DISTINCT "sessionId") > 1) r`);

    const mapCounts = (rows) => rows.map((r) => ({ key: r.key, count: n(r.count), visitors: n(r.visitors) }));
    res.json({
      days, includesHosts: hosts, liveVisitors: n(live && live.visitors),
      totals: Object.fromEntries(Object.entries(totals || {}).map(([k, v]) => [k, n(v)])),
      returningVisitors: n(returning && returning.visitors),
      daily: daily.map((d) => ({ day: d.day, visitors: n(d.visitors), pageviews: n(d.pageviews), listingViews: n(d.listing_views) })),
      funnel: Object.fromEntries(Object.entries(funnel || {}).map(([k, v]) => [k, n(v)])),
      listings: listingRows.map((r) => ({ unitId: r.unitId, name: nameOf[r.unitId] || 'A removed unit', impressions: n(r.impressions), views: n(r.views), viewers: n(r.viewers), checkouts: n(r.checkouts), bookings: n(r.bookings) })),
      clicks: mapCounts(clicks), searches: mapCounts(searches), pages: mapCounts(pages), sources: mapCounts(sources), devices: mapCounts(devices),
    });
  } catch (e) {
    if (/relation "PageEvent" does not exist/i.test(e.message)) return res.json({ empty: true, days: 0 });
    next(e);
  }
});

module.exports = router;
