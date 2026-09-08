/**
 * Quote engine — turns a unit's RateCard + a stay into a priced breakdown.
 * Used by the booking form, invoices, and (later) guest self-booking.
 * Matches Simon's pricing template.
 */

function eachNight(checkIn, checkOut) {
  const nights = [];
  const start = new Date(checkIn + 'T12:00:00Z');
  const end = new Date(checkOut + 'T12:00:00Z');
  for (let d = new Date(start); d.getTime() < end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) nights.push(new Date(d));
  return nights;
}
function isWeekend(date) { const dow = date.getUTCDay(); return dow === 5 || dow === 6; } // Fri, Sat

// Base rate for a given night index (0 = first night, then every night thereafter).
function baseRateFor(rc, nightIndex) {
  const first = rc.firstNightCents;
  const add = rc.additionalNightCents;
  if (nightIndex === 0) return first != null ? first : (add != null ? add : 0);
  return add != null ? add : (first != null ? first : 0);
}

// The nightly base rate for one night: a weekend rate (if set) overrides the
// standard nightly on Fri/Sat. No first-night bundling — the checkout clean is
// charged explicitly below (firstNightCents == nightly + clean by construction,
// so totals are unchanged; this makes per-night overrides clean).
function nightlyRate(rc, date) {
  const wk = rc.weekendNightCents;
  if (isWeekend(date) && wk != null) return wk;
  return rc.additionalNightCents != null ? rc.additionalNightCents : (rc.firstNightCents != null ? rc.firstNightCents : 0);
}

// The effective displayed nightly for a date: a manual override wins (exact, no
// flex); otherwise the rate-card nightly + any seasonal flex.
function effectiveNightly(rc, date, overrides) {
  const iso = date.toISOString().slice(0, 10);
  if (overrides && overrides[iso] != null) return { baseCents: overrides[iso], flexPercent: 0, cents: overrides[iso], overridden: true, weekend: isWeekend(date) };
  const base = nightlyRate(rc, date);
  const flex = nightFlex(rc, date);
  return { baseCents: base, flexPercent: flex, cents: Math.round(base * (1 + flex / 100)), overridden: false, weekend: isWeekend(date) };
}

// Seasonal flex periods match by month-day (recurring every year); Dec->Jan wraps.
function flexCovers(dateISO, f) {
  const d = dateISO.slice(5), a = (f.start || '').slice(5), b = (f.end || '').slice(5);
  if (!a || !b) return false;
  return a <= b ? (d >= a && d <= b) : (d >= a || d <= b);
}
// Highest applicable seasonal flex % for a night (MAX so surcharges never stack).
function nightFlex(rc, date) {
  const iso = date.toISOString().slice(0, 10);
  const flexes = Array.isArray(rc.flexes) ? rc.flexes : [];
  let max = 0;
  for (const f of flexes) { if (flexCovers(iso, f) && (Number(f.percent) || 0) > max) max = Number(f.percent) || 0; }
  return max;
}

/**
 * quote(rc, { checkIn, checkOut, mattress, earlyCheckIn, lateCheckOut, cleans })
 * cleans = number of chargeable cleans (defaults to 1 — the checkout clean).
 */
function quote(rc, { checkIn, checkOut, mattress = false, earlyCheckIn = false, lateCheckOut = false, cleans = 1, overrides = null }) {
  if (!rc || !checkIn || !checkOut) return null;
  const nights = eachNight(checkIn, checkOut);
  const n = nights.length;
  if (n <= 0) return null;

  let accommodation = 0;
  const nightLines = nights.map((d) => {
    const e = effectiveNightly(rc, d, overrides);
    accommodation += e.cents;
    return { date: d.toISOString().slice(0, 10), baseCents: e.baseCents, flexPercent: e.flexPercent, weekend: e.weekend, overridden: e.overridden, cents: e.cents };
  });

  let discountPercent = 0;
  if (n >= 28) discountPercent = rc.monthlyDiscountPercent || 0;
  else if (n >= 7) discountPercent = rc.weeklyDiscountPercent || 0;
  const discountCents = Math.round(accommodation * discountPercent / 100);

  // Checkout clean is charged explicitly (one per stay by default, plus any
  // mid-stay cleans). Firenza's firstNight already equalled nightly + clean, so
  // the stay total is unchanged versus the old bundled model.
  const cleaningCents = (rc.cleaningCents || 0) * Math.max(0, cleans);
  const earlyCents = earlyCheckIn ? (rc.earlyCheckInCents || 0) : 0;
  const lateCents = lateCheckOut ? (rc.lateCheckOutCents || 0) : 0;
  const mattressCents = mattress ? (rc.mattressCents || 0) : 0;
  const breakageCents = rc.breakageDepositCents || 0;

  // Rental = what the stay actually costs. Deposit = refundable breakage hold,
  // collected up front and returned after checkout. Total = payable now.
  const rentalCents = accommodation - discountCents + cleaningCents + earlyCents + lateCents + mattressCents;
  const depositCents = breakageCents;
  const totalCents = rentalCents + depositCents;
  const avgNightlyCents = Math.round(accommodation / n);

  return {
    nights: n, avgNightlyCents,
    accommodationCents: accommodation, discountPercent, discountCents,
    cleaningCents, earlyCents, lateCents, mattressCents, breakageCents,
    rentalCents, depositCents, totalCents, nightLines,
  };
}

module.exports = { quote, baseRateFor, nightlyRate, effectiveNightly };
