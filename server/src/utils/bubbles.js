// Pricing bubbles: a unit's shopfront price follows how full its bubble is.
//
// Occupancy for a night = the share of the bubble's units with a confirmed
// booking that night (any channel, any host). Each host's own rules then set
// the adjustment for their own units:
//   surge  [{ occupancyPct, increasePct }]  — the highest step reached applies
//   drops  [{ withinDays, vacancyPct, decreasePct }] — for nights starting within
//          `withinDays` of today, when at least `vacancyPct` of the bubble is
//          empty; the biggest drop that applies wins
// A surge takes precedence over a drop on the same night. Nights with a manual
// price override are left alone (see pricing.quote).
const prisma = require('../lib/prisma');

const DAY = 864e5;
const MAX_INCREASE = 200; // %
const MAX_DECREASE = 90; // %

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
// Today in South Africa (SAST, UTC+2), as YYYY-MM-DD.
const todaySAST = (now = new Date()) => ymd(new Date(now.getTime() + 2 * 3600 * 1000));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
function eachNight(checkIn, checkOut) {
  const out = [];
  for (let t = Date.parse(`${checkIn}T12:00:00Z`), end = Date.parse(`${checkOut}T12:00:00Z`); t < end; t += DAY) out.push(ymd(t));
  return out;
}

const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 10) / 10)) : null; };

// Tidy rules from the host's form: whole, sensible numbers; empty rows dropped.
function cleanRules(body = {}) {
  const surge = (Array.isArray(body.surge) ? body.surge : [])
    .map((r) => ({ occupancyPct: num(r && r.occupancyPct, 1, 100), increasePct: num(r && r.increasePct, 0.5, MAX_INCREASE) }))
    .filter((r) => r.occupancyPct != null && r.increasePct != null)
    .sort((a, b) => a.occupancyPct - b.occupancyPct).slice(0, 10);
  const drops = (Array.isArray(body.drops) ? body.drops : [])
    .map((r) => ({ withinDays: num(r && r.withinDays, 0, 365), vacancyPct: num(r && r.vacancyPct, 1, 100), decreasePct: num(r && r.decreasePct, 0.5, MAX_DECREASE) }))
    .filter((r) => r.withinDays != null && r.vacancyPct != null && r.decreasePct != null)
    .slice(0, 10);
  return { surge, drops, active: body.active !== false };
}

// The adjustment % for one night, given the bubble's occupancy that night.
function adjustmentFor(rule, occupancyPct, nightISO, today) {
  if (!rule || !rule.active) return 0;
  let up = 0;
  for (const s of rule.surge || []) if (occupancyPct >= s.occupancyPct && s.increasePct > up) up = s.increasePct;
  if (up > 0) return up;
  const vacancy = 100 - occupancyPct;
  const ahead = daysBetween(today, nightISO);
  let down = 0;
  if (ahead >= 0) for (const d of rule.drops || []) if (ahead <= d.withinDays && vacancy >= d.vacancyPct && d.decreasePct > down) down = d.decreasePct;
  return down > 0 ? -down : 0;
}

// Occupancy % per night for a bubble's units, between checkIn and checkOut.
async function occupancyByNight(unitIds, checkIn, checkOut) {
  const nights = eachNight(checkIn, checkOut);
  if (!unitIds.length || !nights.length) return {};
  const bookings = await prisma.booking.findMany({
    where: { unitId: { in: unitIds }, status: 'confirmed', checkIn: { lt: new Date(`${checkOut}T23:59:59Z`) }, checkOut: { gt: new Date(`${checkIn}T00:00:00Z`) } },
    select: { unitId: true, checkIn: true, checkOut: true },
  });
  const out = {};
  for (const n of nights) {
    const busy = new Set(bookings.filter((b) => ymd(b.checkIn) <= n && ymd(b.checkOut) > n).map((b) => b.unitId));
    out[n] = Math.round((busy.size / unitIds.length) * 1000) / 10;
  }
  return out;
}

// The bubble adjustments for a stay at one unit: { 'YYYY-MM-DD': percent }, with
// the bubble's name. Null when the unit isn't in a bubble or its host has no
// rules there. `now` is for tests.
async function bubbleAdjustments(unitId, checkIn, checkOut, { now = new Date() } = {}) {
  const member = await prisma.bubbleMember.findUnique({ where: { unitId }, include: { bubble: { include: { members: { select: { unitId: true } } } } } });
  if (!member) return null;
  const rule = await prisma.bubbleRule.findUnique({ where: { bubbleId_hostId: { bubbleId: member.bubbleId, hostId: member.hostId } } });
  if (!rule || !rule.active) return null;
  const occ = await occupancyByNight(member.bubble.members.map((m) => m.unitId), checkIn, checkOut);
  const today = todaySAST(now);
  const percents = {};
  let any = false;
  for (const [night, o] of Object.entries(occ)) {
    const p = adjustmentFor(rule, o, night, today);
    if (p) { percents[night] = p; any = true; }
  }
  return any ? { bubbleName: member.bubble.name, percents } : null;
}

module.exports = { bubbleAdjustments, occupancyByNight, adjustmentFor, cleanRules, todaySAST, eachNight, MAX_INCREASE, MAX_DECREASE };
