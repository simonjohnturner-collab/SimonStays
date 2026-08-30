/**
 * Quote engine — turns a property's RateCard + a stay into a priced breakdown.
 * Used by both the booking form (suggested price) and invoices (fill amounts).
 */

function eachNight(checkIn, checkOut) {
  const nights = [];
  const start = new Date(checkIn + 'T12:00:00Z');
  const end = new Date(checkOut + 'T12:00:00Z');
  for (let d = new Date(start); d.getTime() < end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    nights.push(new Date(d));
  }
  return nights;
}

function inRange(dateStr, start, end) {
  return start && end && dateStr >= start && dateStr <= end;
}

// Per-night base rate for a given total stay length.
function baseRateFor(rc, nights) {
  const tiers = [rc.nights1Cents, rc.nights2Cents, rc.nights3Cents, rc.nights4Cents, rc.nights5PlusCents];
  const idx = Math.min(nights, 5) - 1; // 1..5+ -> 0..4
  if (tiers[idx] != null) return tiers[idx];
  // fall back to the nearest defined tier (prefer the 5+ nightly, then walk down)
  for (let i = tiers.length - 1; i >= 0; i--) if (tiers[i] != null) return tiers[i];
  return 0;
}

// Surcharge % for one night: special-date category wins over weekend.
function nightSurcharge(rc, date) {
  const iso = date.toISOString().slice(0, 10);
  const specials = Array.isArray(rc.specialDates) ? rc.specialDates : [];
  for (const s of specials) {
    if (inRange(iso, s.start, s.end)) {
      if (s.category === 'christmas') return rc.christmasSurchargePercent || 0;
      if (s.category === 'easter') return rc.easterSurchargePercent || 0;
      return rc.publicHolidaySurchargePercent || 0; // 'public'
    }
  }
  const dow = date.getUTCDay(); // 5 Fri, 6 Sat
  if (dow === 5 || dow === 6) return rc.weekendSurchargePercent || 0;
  return 0;
}

/**
 * quote(rateCard, { checkIn, checkOut, mattress, cleaning })
 * cleaning defaults true (checkout clean is normal); mattress default false.
 */
function quote(rc, { checkIn, checkOut, mattress = false, cleaning = true }) {
  if (!rc || !checkIn || !checkOut) return null;
  const nights = eachNight(checkIn, checkOut);
  const n = nights.length;
  if (n <= 0) return null;

  const base = baseRateFor(rc, n);
  let accommodation = 0;
  const nightLines = nights.map((d) => {
    const sur = nightSurcharge(rc, d);
    const cents = Math.round(base * (1 + sur / 100));
    accommodation += cents;
    return { date: d.toISOString().slice(0, 10), baseCents: base, surchargePercent: sur, cents };
  });

  let discountPercent = 0;
  if (n >= 28) discountPercent = rc.monthlyDiscountPercent || 0;
  else if (n >= 7) discountPercent = rc.weeklyDiscountPercent || 0;
  const discountCents = Math.round(accommodation * discountPercent / 100);

  const cleaningCents = cleaning ? (rc.cleaningCents || 0) : 0;
  const mattressCents = mattress ? (rc.mattressCents || 0) : 0;

  const totalCents = accommodation - discountCents + cleaningCents + mattressCents;
  const avgNightlyCents = Math.round(accommodation / n);

  return {
    nights: n, baseNightlyCents: base, avgNightlyCents,
    accommodationCents: accommodation, discountPercent, discountCents,
    cleaningCents, mattressCents, totalCents, nightLines,
  };
}

module.exports = { quote, baseRateFor };
