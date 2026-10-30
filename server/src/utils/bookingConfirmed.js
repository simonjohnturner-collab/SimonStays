// What happens the first time a booking becomes confirmed — wherever that
// happens (website payment, a new channel booking from sync, a manual booking):
//   1. stamp Booking.confirmedAt (only once — guards everything below)
//   2. WhatsApp the host a confirmation (website + channel bookings; a manual
//      booking was typed in by the host, so they already know)
//   3. send the host's "when a booking is confirmed" scheduled messages
//
// Fire-and-forget from callers: never throws, never blocks the request.
//
// Env (optional): TWILIO_WHATSAPP_BOOKING_CONTENT_SID — an approved WhatsApp
// template for this alert, needed in production outside the 24h session window.
// Variables: {{1}} place · {{2}} guest · {{3}} dates · {{4}} source/amount.
const prisma = require('../lib/prisma');
const wa = require('./whatsapp');
const messaging = require('./messaging');

const SOURCE_LABEL = { website: 'Website', airbnb: 'Airbnb', booking: 'Booking.com', lekkeslaap: 'LekkeSlaap', import: 'Channel', manual: 'Manual' };

function fmtDay(d) {
  try { return new Date(d).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  catch (e) { return new Date(d).toISOString().slice(0, 10); }
}
const rand = (c) => 'R' + (c / 100).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function hostAlert(b) {
  const place = [b.unit?.property?.name, b.unit?.name && `Unit ${b.unit.name}`].filter(Boolean).join(' · ') || 'a unit';
  const nights = Math.max(0, Math.round((new Date(b.checkOut) - new Date(b.checkIn)) / 864e5));
  const dates = `${fmtDay(b.checkIn)} → ${fmtDay(b.checkOut)} (${nights} night${nights === 1 ? '' : 's'})`;
  const amount = b.totalCents != null ? b.totalCents : b.quotedCents;
  const source = [SOURCE_LABEL[b.source] || b.source, b.ref || b.resCode, amount != null ? rand(amount) : null].filter(Boolean).join(' · ');
  const guest = b.guestName || 'Guest';
  const body = `✅ Booking confirmed — ${place}\n👤 ${guest}\n📅 ${dates}\n💳 ${source}`;
  return { body, contentVariables: { 1: place, 2: guest, 3: dates, 4: source } };
}

async function notifyHost(b) {
  if (!wa.enabled()) return { ok: false, skipped: 'no_creds' };
  const hostId = messaging.hostIdOf(b);
  const host = hostId && await prisma.host.findUnique({ where: { id: hostId }, select: { contactPhone: true, biller: { select: { phone: true } } } });
  const phone = host && (host.contactPhone || (host.biller && host.biller.phone));
  if (!phone) return { ok: false, skipped: 'no_host_phone' };
  const { body, contentVariables } = hostAlert(b);
  // Pass contentSid explicitly (even null) so the cleaner-reminder template set in
  // TWILIO_WHATSAPP_CONTENT_SID is never used for this message.
  return wa.sendWhatsApp({ to: phone, body, contentSid: process.env.TWILIO_WHATSAPP_BOOKING_CONTENT_SID || null, contentVariables });
}

async function onBookingConfirmed(bookingId) {
  try {
    // Atomic claim: only the first caller for this booking gets count 1.
    const claimed = await prisma.booking.updateMany({ where: { id: bookingId, status: 'confirmed', confirmedAt: null }, data: { confirmedAt: new Date() } });
    if (!claimed.count) return { skipped: 'already_confirmed' };
    const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: { ...messaging.BOOKING_INCLUDE, guestAccount: { select: { email: true } } } });
    if (!b) return { skipped: 'not_found' };
    const out = {};
    if (b.source !== 'manual') {
      out.whatsapp = await notifyHost(b);
      if (!out.whatsapp.ok) console.warn('[booking-confirmed] host WhatsApp not sent', b.id, out.whatsapp.skipped || out.whatsapp.error);
    }
    out.messages = await messaging.runConfirmedSchedules(b);
    return out;
  } catch (e) {
    console.error('[booking-confirmed] failed', bookingId, e.message);
    return { error: e.message };
  }
}

module.exports = { onBookingConfirmed, hostAlert };
