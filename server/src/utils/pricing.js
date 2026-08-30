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
function inRange(iso, start, end) { return start && end && iso >= start && iso <= end; }

// Per-night base rate for the whole stay length: 1, 2, 3, or 4+ nights.
function baseRateFor(rc, nights) {
  const tiers = [rc.nights1Cents, rc.nights2Cents, rc.nights3Cents, rc.nights4PlusCents];
  const idx = Math.min(nights, 4) - 1;
  if (tiers[idx] != null) return tiers[idx];
  for (let i = tiers.length - 1; i >= 0; i--) if (tiers[i] != null) return tiers[i];
  return 0;
}

// Highest applicable upward flex % for a night (weekend + any seasonal flex whose
// period covers it). We take the MAX so surcharges never silently stack.
function nightFlex(rc, date) {
  const iso = date.toISOString().slice(0, 10);
  let max = 0;
  const specials = Array.isArray(rc.specialDates) ? rc.specialDates : [];
  for (const s of specials) {
    if (!inRange(iso, s.start, s.end)) continue;
    const p = s.flex === 'flex1' ? rc.flex1Percent : s.flex === 'flex2' ? rc.flex2Percent : s.flex === 'flex3' ? rc.flex3Percent : 0;
    if ((p || 0) > max) max = p;
  }
  const dow = date.getUTCDay(); // 5 Fri, 6 Sat
  if ((dow === 5 || dow === 6) && (rc.weekendFlexPercent || 0) > max) max = rc.weekendFlexPercent;
  return max;
}

/**
 * quote(rc, { checkIn, checkOut, mattress, earlyCheckIn, lateCheckOut, cleans })
 * cleans = number of chargeable cleans (defaults to 1 — the checkout clean).
 */
function quote(rc, { checkIn, checkOut, mattress = false, earlyCheckIn = false, lateCheckOut = false, cleans = 1 }) {
  if (!rc || !checkIn || !checkOut) return null;
  const nights = eachNight(checkIn, checkOut);
  const n = nights.length;
  if (n <= 0) return null;

  const base = baseRateFor(rc, n);
  let accommodation = 0;
  const nightLines = nights.map((d) => {
    const flex = nightFlex(rc, d);
    const cents = Math.round(base * (1 + flex / 100));
    accommodation += cents;
    return { date: d.toISOString().slice(0, 10), baseCents: base, flexPercent: flex, cents };
  });

  let discountPercent = 0;
  if (n >= 28) discountPercent = rc.monthlyDiscountPercent || 0;
  else if (n >= 7) discountPercent = rc.weeklyDiscountPercent || 0;
  const discountCents = Math.round(accommodation * discountPercent / 100);

  const cleaningCents = (rc.cleaningCents || 0) * Math.max(0, cleans);
  const earlyCents = earlyCheckIn ? (rc.earlyCheckInCents || 0) : 0;
  const lateCents = lateCheckOut ? (rc.lateCheckOutCents || 0) : 0;
  const mattressCents = mattress ? (rc.mattressCents || 0) : 0;
  const breakageCents = rc.breakageDepositCents || 0;

  const totalCents = accommodation - discountCents + cleaningCents + earlyCents + lateCents + mattressCents + breakageCents;
  const avgNightlyCents = Math.round(accommodation / n);

  return {
    nights: n, baseNightlyCents: base, avgNightlyCents,
    accommodationCents: accommodation, discountPercent, discountCents,
    cleaningCents, earlyCents, lateCents, mattressCents, breakageCents,
    totalCents, nightLines,
  };
}

module.exports = { quote, baseRateFor };
