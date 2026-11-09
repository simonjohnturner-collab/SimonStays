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

// Who a visitor is, where we know: their guest account, or the booking they placed.
async function whoIs(accountIds, bookingIds) {
  const [accts, bookings] = await Promise.all([
    accountIds.length ? prisma.guestAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, name: true, email: true, phone: true } }) : [],
    bookingIds.length ? prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, guestName: true, guestEmail: true, guestPhone: true, status: true, paid: true } }) : [],
  ]);
  return { acct: Object.fromEntries(accts.map((a) => [a.id, a])), booking: Object.fromEntries(bookings.map((b) => [b.id, b])) };
}
const placeName = (u) => (u ? [u.property && u.property.name, u.name && `Unit ${u.name}`].filter(Boolean).join(' · ') : null);

// GET /admin/traffic/visitors?days=7 — recent visitors, newest first: who (when
// known), where from, how far they got, and the listings they opened. Plus the
// people worth following up: checkouts never paid, and known visitors who looked
// or started checkout without booking.
router.get('/visitors', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const since = new Date(Date.now() - days * 864e5);
    const hostCond = req.query.hosts === '1' ? '' : 'AND "isHost" = false';
    const rows = await prisma.$queryRawUnsafe(`SELECT "visitorId",
        MIN("at") AS first, MAX("at") AS last, COUNT(DISTINCT "sessionId") AS sessions,
        COUNT(*) FILTER (WHERE type = 'pageview') AS pageviews,
        BOOL_OR(type = 'search') AS searched, BOOL_OR(type = 'view_listing') AS viewed,
        BOOL_OR(type = 'start_checkout') AS checkout, BOOL_OR(type IN ('booking_placed', 'booked', 'request_sent')) AS booked,
        BOOL_OR(type = 'enquiry_sent') AS asked,
        MAX("guestAccountId") AS account, ARRAY_AGG(DISTINCT "bookingId") FILTER (WHERE "bookingId" IS NOT NULL) AS bookings,
        ARRAY_AGG(DISTINCT "unitId") FILTER (WHERE type = 'view_listing' AND "unitId" IS NOT NULL) AS units,
        MAX(device) AS device, MAX(NULLIF(source, '')) AS source
      FROM "PageEvent" WHERE "at" >= ($1::timestamptz AT TIME ZONE 'UTC') ${hostCond}
      GROUP BY "visitorId" ORDER BY MAX("at") DESC LIMIT 150`, since);
    const unitIds = [...new Set(rows.flatMap((r) => r.units || []))];
    const units = unitIds.length ? await prisma.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, name: true, property: { select: { name: true } } } }) : [];
    const unitName = Object.fromEntries(units.map((u) => [u.id, placeName(u)]));
    const who = await whoIs([...new Set(rows.map((r) => r.account).filter(Boolean))], [...new Set(rows.flatMap((r) => r.bookings || []))]);

    const visitors = rows.map((r) => {
      const a = r.account && who.acct[r.account];
      const bk = (r.bookings || []).map((id) => who.booking[id]).find(Boolean);
      const person = a ? { name: a.name, email: a.email, phone: a.phone } : bk ? { name: bk.guestName, email: bk.guestEmail, phone: bk.guestPhone } : null;
      const unpaid = bk && !bk.paid && bk.status !== 'confirmed';
      const step = r.booked ? (unpaid ? 'Booking not paid' : 'Booked or requested') : r.checkout ? 'Started checkout' : r.asked ? 'Asked a question' : r.viewed ? 'Opened a listing' : r.searched ? 'Searched' : 'Looked around';
      return {
        id: r.visitorId, person, first: r.first, last: r.last, sessions: Number(r.sessions), pageviews: Number(r.pageviews),
        step, device: r.device, source: r.source || null, listings: (r.units || []).map((id) => unitName[id]).filter(Boolean),
        bookingPaid: bk ? !!bk.paid || bk.status === 'confirmed' : null,
      };
    });

    // People to follow up.
    const abandoned = await prisma.booking.findMany({
      where: { source: 'website', createdAt: { gte: since }, paid: false, OR: [{ status: 'pending' }, { status: 'cancelled', comments: { contains: 'payment not completed' } }] },
      include: { unit: { select: { name: true, property: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' }, take: 50,
    });
    const iso = (d) => new Date(d).toISOString().slice(0, 10);
    const followUps = [
      ...abandoned.map((b) => ({
        kind: 'checkout', why: b.status === 'pending' ? 'Started a booking, hasn’t paid' : 'Booking lapsed: card payment never completed',
        name: b.guestName, email: b.guestEmail, phone: b.guestPhone, place: placeName(b.unit), dates: `${iso(b.checkIn)} → ${iso(b.checkOut)}`,
        amountCents: b.totalCents, at: b.createdAt,
      })),
      ...visitors.filter((v) => v.person && !v.step.startsWith('Booked') && (v.step === 'Started checkout' || v.step === 'Opened a listing' || v.step === 'Asked a question'))
        .filter((v) => !abandoned.some((b) => b.guestEmail && v.person.email && b.guestEmail.toLowerCase() === v.person.email.toLowerCase()))
        .map((v) => ({ kind: 'browsed', why: v.step === 'Started checkout' ? 'Started checkout, didn’t book' : v.step === 'Asked a question' ? 'Asked a question, hasn’t booked' : `Looked at ${v.listings.slice(0, 2).join(', ') || 'listings'}, didn’t book`, name: v.person.name, email: v.person.email, phone: v.person.phone, place: v.listings[0] || null, at: v.last, visitorId: v.id })),
    ];
    res.json({ days, visitors, followUps });
  } catch (e) {
    if (/relation "PageEvent" does not exist|column .* does not exist/i.test(e.message)) return res.json({ days: 0, visitors: [], followUps: [], empty: true });
    next(e);
  }
});

// GET /admin/traffic/visitors/:id — one visitor's journey, oldest first.
router.get('/visitors/:id', async (req, res, next) => {
  try {
    const events = await prisma.pageEvent.findMany({ where: { visitorId: String(req.params.id) }, orderBy: { at: 'asc' }, take: 400 });
    const units = [...new Set(events.map((e) => e.unitId).filter(Boolean))];
    const names = units.length ? Object.fromEntries((await prisma.unit.findMany({ where: { id: { in: units } }, select: { id: true, name: true, property: { select: { name: true } } } })).map((u) => [u.id, placeName(u)])) : {};
    res.json({ events: events.map((e) => ({ at: e.at, type: e.type, path: e.path, label: e.label, place: e.unitId ? names[e.unitId] || null : null, session: e.sessionId, device: e.device, source: e.source })) });
  } catch (e) { next(e); }
});

module.exports = router;
