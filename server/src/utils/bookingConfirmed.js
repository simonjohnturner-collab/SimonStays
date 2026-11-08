// What happens the first time a booking becomes confirmed — wherever that
// happens (website payment, a new channel booking from sync, a manual booking):
//   1. stamp Booking.confirmedAt (only once — guards everything below)
//   2. WhatsApp the host a confirmation (website + channel bookings; a manual
//      booking was typed in by the host, so they already know)
//   3. email the guest their confirmation, unless their paid invoice is about to say so
//   4. send the host's "when a booking is confirmed" scheduled messages
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
  const dates = b.dayUse ? `${fmtDay(b.checkIn)} (day use)` : `${fmtDay(b.checkIn)} → ${fmtDay(b.checkOut)} (${nights} night${nights === 1 ? '' : 's'})`;
  const amount = b.totalCents != null ? b.totalCents : b.quotedCents;
  const source = [SOURCE_LABEL[b.source] || b.source, b.ref || b.resCode, amount != null ? rand(amount) : null].filter(Boolean).join(' · ');
  const guest = b.guestName || 'Guest';
  if (b.source === 'website') {
    // A SimonStays booking: congratulate the host and show what they earn. Matches
    // the approved WhatsApp template (TWILIO_WHATSAPP_BOOKING_CONTENT_SID).
    const { grossOf, feeOf } = require('./fees');
    const gross = grossOf(b);
    const money = gross ? `${rand(gross)} booking · you earn ${rand(gross - feeOf(gross))}` : source;
    const body = `🎉 Congratulations, you have a new booking on SimonStays!\n\n🏠 ${place}\n👤 ${guest}\n📅 ${dates}\n💰 ${money}\n\nSee it in your SimonStays calendar.`;
    return { body, contentVariables: { 1: place, 2: guest, 3: dates, 4: money } };
  }
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

// The guest's WhatsApp confirmation, for a booking they made on SimonStays.
// Needs an approved template (TWILIO_WHATSAPP_GUEST_CONTENT_SID,
// "simonstays_guest_confirmed"): WhatsApp won't deliver a plain message to a
// guest who hasn't messaged us first, so without one nothing is sent.
// Variables: {{1}} first name · {{2}} place · {{3}} dates with times · {{4}} booking ref.
function guestConfirmation(b) {
  const name = String(b.guestName || '').trim().split(/\s+/)[0] || 'there';
  const place = [b.unit?.property?.name, b.unit?.name && `Unit ${b.unit.name}`].filter(Boolean).join(' · ') || 'your stay';
  const inTime = b.unit?.checkInTime || b.unit?.property?.checkInTime || '15:00';
  const outTime = b.unit?.checkOutTime || b.unit?.property?.checkOutTime || '10:00';
  const dates = b.dayUse ? `${fmtDay(b.checkIn)} (day use)` : `${fmtDay(b.checkIn)} from ${inTime} → ${fmtDay(b.checkOut)} by ${outTime}`;
  const ref = b.ref || '—';
  const site = (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
  const body = `Hi ${name}, your SimonStays booking is confirmed 🎉\n\n🏠 ${place}\n📅 ${dates}\n🔖 Booking ref ${ref}\n\nYour trip details and messages with your host are under Trips on ${site.replace(/^https?:\/\//, '')}. We look forward to hosting you!`;
  return { body, contentVariables: { 1: name, 2: place, 3: dates, 4: ref } };
}

async function notifyGuest(b) {
  const template = String(process.env.TWILIO_WHATSAPP_GUEST_CONTENT_SID || '').trim();
  if (!wa.enabled() || !template) return { ok: false, skipped: !template ? 'no_template' : 'no_creds' };
  if (b.source !== 'website') return { ok: false, skipped: 'not_simonstays' }; // Airbnb etc. message their own guests
  if (b.sourceOfferId) return { ok: false, skipped: 'extra_unit' }; // one message per invoice, not per extra unit
  const phone = b.guestPhone || (b.guestAccount && b.guestAccount.phone);
  if (!phone) return { ok: false, skipped: 'no_guest_phone' };
  const { body, contentVariables } = guestConfirmation(b);
  return wa.sendWhatsApp({ to: phone, body, contentSid: template, contentVariables });
}

function confirmationText(b) {
  const name = String(b.guestName || '').trim().split(/\s+/)[0];
  const owing = b.source === 'website' && !b.paid ? b.amountOwingCents || 0 : 0;
  return `Thank you${name ? `, ${name}` : ''}. Your booking is confirmed, and we look forward to hosting you.${owing > 0 ? ` The balance of ${rand(owing)} is due at least 3 days before check-in.` : ''}`;
}

async function onBookingConfirmed(bookingId, { invoiceFollows = false } = {}) {
  try {
    // Atomic claim: only the first caller for this booking gets count 1.
    const claimed = await prisma.booking.updateMany({ where: { id: bookingId, status: 'confirmed', confirmedAt: null }, data: { confirmedAt: new Date() } });
    if (!claimed.count) return { skipped: 'already_confirmed' };
    const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: { ...messaging.BOOKING_INCLUDE, guestAccount: { select: { email: true, phone: true } } } });
    if (!b) return { skipped: 'not_found' };
    const out = {};
    if (b.source !== 'manual') {
      out.whatsapp = await notifyHost(b);
      if (!out.whatsapp.ok) console.warn('[booking-confirmed] host WhatsApp not sent', b.id, out.whatsapp.skipped || out.whatsapp.error);
    }
    out.guestWhatsapp = await notifyGuest(b);
    if (!out.guestWhatsapp.ok && !['no_template', 'not_simonstays', 'extra_unit'].includes(out.guestWhatsapp.skipped)) console.warn('[booking-confirmed] guest WhatsApp not sent', b.id, out.guestWhatsapp.skipped || out.guestWhatsapp.error);
    // A slow mail server mustn't hold up whoever confirmed the booking.
    if (!invoiceFollows) messaging.emailBookingNotice(b, 'confirmed', confirmationText(b)).catch((e) => console.error('[booking-confirmed] email failed', b.id, e.message));
    out.messages = await messaging.runConfirmedSchedules(b);
    return out;
  } catch (e) {
    console.error('[booking-confirmed] failed', bookingId, e.message);
    return { error: e.message };
  }
}

module.exports = { onBookingConfirmed, hostAlert, guestConfirmation };
