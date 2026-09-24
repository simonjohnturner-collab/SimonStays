// Night-before-checkout reminder to the checkout cleaner.
// Runs daily at 19:00 SAST: finds every confirmed booking checking out TOMORROW,
// looks up the checkout cleaner's phone in the ServiceProvider directory, and
// WhatsApps a reminder (including any checkout notes on the booking).
//
// Dormant-safe: does nothing unless Twilio WhatsApp creds are set (whatsapp.enabled()).
const prisma = require('../lib/prisma');
const wa = require('./whatsapp');

// SAST is UTC+2 year-round (no DST), so we can shift by a fixed offset.
const SAST_MS = 2 * 60 * 60 * 1000;

// The UTC day-range for "tomorrow" in SAST, relative to `now`. Checkout dates are
// stored at noon UTC (dateOnly), which always falls inside this range.
function tomorrowRange(now) {
  const s = new Date(now.getTime() + SAST_MS);
  const y = s.getUTCFullYear(), m = s.getUTCMonth(), d = s.getUTCDate();
  return { start: new Date(Date.UTC(y, m, d + 1, 0, 0, 0)), end: new Date(Date.UTC(y, m, d + 2, 0, 0, 0)) };
}

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' }); }
  catch (e) { return new Date(d).toISOString().slice(0, 10); }
}
function placeOf(b) {
  return [b.unit && b.unit.property ? b.unit.property.name : null, b.unit ? b.unit.name : null].filter(Boolean).join(' · ') || 'the unit';
}
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }

function buildMessage(b) {
  let msg = `Hi ${firstName(b.cleaner)}, a reminder from SimonStays: you're cleaning ${placeOf(b)} tomorrow (${fmtDate(b.checkOut)}) after checkout.`;
  if (b.checkoutNotes && b.checkoutNotes.trim()) msg += `\n\n📋 Checkout notes: ${b.checkoutNotes.trim()}`;
  msg += `\n\nThank you!`;
  return msg;
}

async function cleanerPhone(hostId, name) {
  if (!hostId || !name) return null;
  const p = await prisma.serviceProvider.findFirst({
    where: { hostId, name: { equals: name.trim(), mode: 'insensitive' } },
    select: { phone: true },
  });
  return p && p.phone ? p.phone : null;
}

// Send the reminder for one booking. `force` re-sends even if already reminded
// (used by the manual "Send reminder now" button).
async function remindForBooking(booking, { force = false } = {}) {
  const b = booking.unit ? booking
    : await prisma.booking.findUnique({ where: { id: booking.id }, include: { unit: { include: { property: true } } } });
  if (!b) return { ok: false, reason: 'not_found' };
  if (!force && b.checkoutReminderAt) return { ok: false, reason: 'already_sent' };
  if (!b.cleaner) return { ok: false, reason: 'no_cleaner' };
  const hostId = b.hostId || (b.unit && b.unit.property ? b.unit.property.hostId : null);
  const phone = await cleanerPhone(hostId, b.cleaner);
  if (!phone) return { ok: false, reason: 'no_phone' };

  const body = buildMessage(b);
  // Template variables (used only if TWILIO_WHATSAPP_CONTENT_SID is set):
  // {{1}} cleaner first name · {{2}} place · {{3}} date · {{4}} checkout notes
  const contentVariables = {
    1: firstName(b.cleaner), 2: placeOf(b), 3: fmtDate(b.checkOut), 4: (b.checkoutNotes || '').trim() || '—',
  };
  const res = await wa.sendWhatsApp({ to: phone, body, contentVariables });
  if (res.ok) await prisma.booking.update({ where: { id: b.id }, data: { checkoutReminderAt: new Date() } }).catch(() => {});
  return { ...res, cleaner: b.cleaner, phone };
}

// The daily 19:00 job.
async function runDaily(now = new Date()) {
  if (!wa.enabled()) return { skipped: 'no_creds' };
  const { start, end } = tomorrowRange(now);
  const bookings = await prisma.booking.findMany({
    where: { checkOut: { gte: start, lt: end }, status: 'confirmed', cleaner: { not: null } },
    include: { unit: { include: { property: true } } },
  });
  const out = { total: bookings.length, sent: 0, skipped: [] };
  for (const b of bookings) {
    const r = await remindForBooking(b);
    if (r.ok) out.sent++;
    else out.skipped.push({ id: b.id, cleaner: b.cleaner, reason: r.reason || r.error });
  }
  return out;
}

module.exports = { runDaily, remindForBooking, enabled: wa.enabled, buildMessage, tomorrowRange };
