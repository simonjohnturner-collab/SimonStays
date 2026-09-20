/**
 * Competitor market probe — the "building fill" gauge.
 *
 * Reads another operator's live booking engine to see, for a rolling window of
 * future nights, which room types are still bookable and at what price. Aggregated
 * over time this gives a proxy occupancy rate + a price curve for the building, so
 * we can price our own units against what the market is doing.
 *
 * Today this supports SiteMinder's "The Booking Button" (TBB), the GraphQL engine
 * behind direct-book.com — used by CAG for The Vantage (channelCode
 * "TheVantageDirect"). The API is public (no login), keyed by channelCode:
 *   POST https://direct-book.com/api/graphql
 *     query roomTypes(channelCode, checkInDate, checkOutDate) -> availability + rates
 *     query quote(roomRateId, checkInDate, checkOutDate)      -> price for a night
 *
 * Availability signal: roomTypes returns `minAvailability` per room type for the
 * dates. We treat `minAvailability > 0` as bookable. Price comes from `quote` on
 * the room type's standard rate. Both the availability count and the raw quote are
 * kept on each snapshot so the signal can be re-checked (e.g. if the engine ever
 * gates availability behind its bot-challenge, we switch to the quote-success
 * signal without a schema change).
 */
const prisma = require('../lib/prisma');

const DEFAULT_API_BASE = 'https://direct-book.com';
// A normal browser UA — the engine sits behind a WAF that is unfriendly to blank
// clients. We only ever read public availability, the same data a guest sees.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function config() {
  return {
    windowDays: Number(process.env.MARKET_WINDOW_DAYS) || 90, // nights ahead to probe (daily cron)
    stayNights: 1, // each probe is a 1-night stay (check-in -> +1 day)
    reqDelayMs: Number(process.env.MARKET_REQ_DELAY_MS) || 250, // politeness between calls
  };
}

/** No hard prerequisites — probeAll simply no-ops when there are no active TBB competitors. */
function enabled() {
  return true;
}

// ---- date helpers (match the repo convention: date-only stored at noon UTC) ----
function isoDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function noonUTC(dateStr) {
  return new Date(`${dateStr}T12:00:00.000Z`);
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- SiteMinder TBB GraphQL client ----
const ROOM_TYPES_QUERY = `query roomTypes($channelCode: String!, $checkInDate: String, $checkOutDate: String, $locale: String) {
  roomTypes(channelCode: $channelCode, checkInDate: $checkInDate, checkOutDate: $checkOutDate, locale: $locale) {
    uuid
    name
    category
    minAvailability
    maxOccupancy
    rates { uuid name ratePlanId promotional }
  }
}`;

const QUOTE_QUERY = `query quote($roomRateId: Int!, $checkInDate: String!, $checkOutDate: String!, $adults: Int) {
  quote(roomRateId: $roomRateId, checkInDate: $checkInDate, checkOutDate: $checkOutDate, adults: $adults) {
    roomRateId
    name
    price { net tax gross amount }
    errors { type key }
  }
}`;

/** POST a GraphQL query to the engine. Throws on transport or validation errors. */
async function graphql(apiBase, query, variables) {
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
  const res = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
      Origin: base,
      Referer: `${base}/`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`TBB ${res.status}: non-JSON response (${text.slice(0, 120)})`);
  }
  if (json.errors && json.errors.length) {
    // A validation error means the query no longer matches the engine's schema —
    // surface it loudly rather than silently reading everything as "unavailable".
    const validation = json.errors.find(
      (e) => e?.extensions?.code === 'GRAPHQL_VALIDATION_FAILED'
    );
    if (validation) throw new Error(`TBB schema error: ${validation.message}`);
    // Other errors (e.g. no availability for the dates) are returned to the caller.
  }
  return json;
}

/** Fetch the room-type catalogue + availability for one night. */
async function fetchRoomTypes(competitor, checkInDate, checkOutDate) {
  const json = await graphql(competitor.apiBase, ROOM_TYPES_QUERY, {
    channelCode: competitor.channelCode,
    checkInDate,
    checkOutDate,
    locale: 'en',
  });
  return json?.data?.roomTypes || [];
}

/** Pick the standard (non-promotional) rate for a room type, for a stable price signal. */
function pickRate(rt) {
  const rates = rt.rates || [];
  return rates.find((r) => !r.promotional) || rates[0] || null;
}

/** Pick the promotional rate, if the operator is running one (measures discount depth). */
function pickPromoRate(rt) {
  return (rt.rates || []).find((r) => r.promotional) || null;
}

/**
 * Quote a night for one rate. The engine returns a real `price.gross` only when
 * the room is bookable for the dates and surfaces availability problems in
 * `errors` — so a priced, error-free quote is our availability signal (the
 * `minAvailability` count is gated server-side and reads 0). Returns
 * { available, priceCents, errors } (price is kept even when unavailable, for
 * reference; the aggregation charts price only for available nights).
 */
async function quoteNight(competitor, roomRateId, checkInDate, checkOutDate) {
  const id = Number(roomRateId);
  if (!Number.isFinite(id)) return { available: false, priceCents: null, errors: ['bad_rate_id'] };
  const json = await graphql(competitor.apiBase, QUOTE_QUERY, {
    roomRateId: id,
    checkInDate,
    checkOutDate,
    adults: 2,
  });
  const q = json?.data?.quote;
  if (!q) return { available: false, priceCents: null, errors: ['no_quote'] };
  const gross = Number(q.price?.gross);
  const errors = (q.errors || []).map((e) => e.type || e.key).filter(Boolean);
  const priceCents = Number.isFinite(gross) && gross > 0 ? Math.round(gross * 100) : null;
  const available = priceCents != null && errors.length === 0;
  return { available, priceCents, errors };
}

/**
 * Probe one SiteMinder-TBB competitor over the rolling window and upsert one
 * MarketSnapshot per (room type, night) for today's capture bucket.
 * Returns a summary. Availability is taken from roomTypes.minAvailability; the
 * price is taken from the quote for the room type's standard rate.
 */
async function probeCompetitor(competitor, opts = {}) {
  const cfg = config();
  const days = opts.days || cfg.windowDays;
  const write = opts.write !== false; // default: persist
  if (competitor.source !== 'SITEMINDER_TBB' || !competitor.channelCode) {
    return { skipped: 'not_a_tbb_competitor', competitor: competitor.name };
  }

  const today = isoDate(new Date());
  const capturedDate = noonUTC(today);
  const summary = { competitor: competitor.name, nights: 0, rows: 0, available: 0, errors: 0, rowsOut: [] };

  for (let i = 0; i < days; i++) {
    const checkInDate = addDays(today, i);
    const checkOutDate = addDays(checkInDate, cfg.stayNights);
    let roomTypes;
    try {
      roomTypes = await fetchRoomTypes(competitor, checkInDate, checkOutDate);
    } catch (e) {
      summary.errors++;
      console.error(`[market] ${competitor.name} ${checkInDate} roomTypes failed: ${e.message}`);
      await sleep(cfg.reqDelayMs);
      continue;
    }
    summary.nights++;

    for (const rt of roomTypes) {
      const minAvail = Number(rt.minAvailability) || 0;
      const rate = pickRate(rt);
      const promoRate = pickPromoRate(rt);
      let priceCents = null;
      let promoPriceCents = null;
      let available = false;
      let quoteErrors = [];
      if (rate) {
        try {
          const q = await quoteNight(competitor, rate.uuid, checkInDate, checkOutDate);
          priceCents = q.priceCents;
          available = q.available; // quote-based; note the engine tends to quote every date
          quoteErrors = q.errors || [];
        } catch (e) {
          summary.errors++;
          console.error(`[market] ${competitor.name} ${checkInDate} "${rt.name}" quote failed: ${e.message}`);
        }
        await sleep(cfg.reqDelayMs);
      }
      // The promotional rate, when offered, tells us how hard they're discounting.
      if (promoRate && promoRate.uuid !== rate?.uuid) {
        try {
          const pq = await quoteNight(competitor, promoRate.uuid, checkInDate, checkOutDate);
          promoPriceCents = pq.priceCents;
        } catch (e) {
          console.error(`[market] ${competitor.name} ${checkInDate} "${rt.name}" promo quote failed: ${e.message}`);
        }
        await sleep(cfg.reqDelayMs);
      }

      const row = {
        competitorId: competitor.id,
        capturedDate,
        stayDate: noonUTC(checkInDate),
        roomType: (rt.name || '').trim() || 'Unknown',
        roomTypeExtId: rt.uuid || null,
        available,
        availableUnits: minAvail, // from roomTypes; gated to 0 server-side, kept for reference
        priceCents,
        promoPriceCents,
        currency: competitor.currency || 'ZAR',
        raw: {
          minAvailability: minAvail,
          rateId: rate?.uuid || null,
          rateName: rate?.name || null,
          promoRateId: promoRate?.uuid || null,
          quoteErrors,
        },
      };

      if (write) {
        await prisma.marketSnapshot.upsert({
          where: {
            competitorId_stayDate_roomType_capturedDate: {
              competitorId: competitor.id,
              stayDate: row.stayDate,
              roomType: row.roomType,
              capturedDate: row.capturedDate,
            },
          },
          update: {
            available: row.available,
            availableUnits: row.availableUnits,
            priceCents: row.priceCents,
            promoPriceCents: row.promoPriceCents,
            roomTypeExtId: row.roomTypeExtId,
            currency: row.currency,
            raw: row.raw,
            capturedAt: new Date(),
          },
          create: row,
        });
      }
      summary.rows++;
      if (available) summary.available++;
      summary.rowsOut.push({
        stayDate: checkInDate,
        roomType: row.roomType,
        available,
        price: priceCents != null ? (priceCents / 100).toFixed(2) : null,
        promo: promoPriceCents != null ? (promoPriceCents / 100).toFixed(2) : null,
      });
    }
  }
  return summary;
}

/** Probe every active SiteMinder-TBB competitor across all hosts. */
async function probeAll(opts = {}) {
  const competitors = await prisma.competitor.findMany({
    where: { active: true, source: 'SITEMINDER_TBB', channelCode: { not: null } },
  });
  const results = [];
  for (const c of competitors) {
    try {
      results.push(await probeCompetitor(c, opts));
    } catch (e) {
      console.error(`[market] probe failed for ${c.name}: ${e.message}`);
      results.push({ competitor: c.name, error: e.message });
    }
  }
  return results;
}

module.exports = {
  config,
  enabled,
  graphql,
  fetchRoomTypes,
  quoteNight,
  probeCompetitor,
  probeAll,
  // exported for tests / scripts
  _internals: { isoDate, noonUTC, addDays, pickRate, ROOM_TYPES_QUERY, QUOTE_QUERY, DEFAULT_API_BASE },
};
