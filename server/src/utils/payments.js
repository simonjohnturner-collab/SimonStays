// Payment abstraction for the public shopfront booking site (Paygate PayWeb3).
//
// PAYMENT_MODE:
//   simulate (default) — no real charge, so the booking flow can be tested end to end
//   sandbox            — Paygate's test account (test cards, no real money)
//   live               — real payments; needs PAYGATE_ID / PAYGATE_KEY
//
// A booking is only CONFIRMED (and the calendar blocked) after Paygate itself
// says the payment was approved — we always ask Paygate (query.trans) rather
// than trusting the guest's browser or even the notify post on its own.
const prisma = require('../lib/prisma');
const paygate = require('./paygate');

const MODE = paygate.mode();
const isOnline = () => paygate.ready();

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const placeOf = (b) => [b.unit?.property?.name, b.unit?.name && `Unit ${b.unit.name}`].filter(Boolean).join(' · ') || 'a unit';

// Paygate requires a customer email; fall back to the host's when the guest gave only a phone.
async function emailFor(b) {
  if (b.guestEmail) return b.guestEmail;
  const hostId = b.hostId || b.unit?.property?.hostId;
  const h = hostId && await prisma.host.findUnique({ where: { id: hostId }, select: { email: true, biller: { select: { email: true } } } });
  return (h && (h.biller?.email || h.email)) || 'bookings@simonstays.co.za';
}

// Start a payment. `base` is the site's own origin (for Paygate's return and
// notify URLs). Returns { mode:'simulate' } or { mode:'form', action, fields }.
async function createCheckout(booking, amountCents, { base, kind = 'booking' } = {}) {
  if (!isOnline() || !base) return { mode: 'simulate', amountCents };
  const b = booking.unit ? booking : await prisma.booking.findUnique({ where: { id: booking.id }, include: { unit: { include: { property: true } } } });
  const payment = await prisma.payment.create({ data: { bookingId: b.id, kind, amountCents, provider: 'paygate' } });
  const init = await paygate.initiate({
    reference: payment.id, amountCents, email: await emailFor(b), user1: kind,
    returnUrl: `${base}/public/paygate/return/${payment.id}`,
    notifyUrl: `${base}/public/paygate/notify`,
  });
  await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: init.payRequestId } });
  return { mode: 'form', paymentId: payment.id, amountCents, ...init.form };
}

// Used by POST /public/book/:id/pay. Only simulate mode confirms from the
// browser; online payments are confirmed with Paygate (reconcile).
async function verifyPayment() {
  if (!isOnline()) return { ok: true, simulated: true };
  return { ok: false, message: 'Your payment is confirmed by Paygate directly — please complete payment on the secure payment page.' };
}

// Ask Paygate how a payment went and apply the answer. Safe to call any number
// of times (notify, return, status polling): each outcome is applied once.
async function reconcile(payment, { query = paygate.query } = {}) {
  if (!payment || !payment.providerRef) return { ok: false, reason: 'not_started' };
  if (payment.status !== 'pending') return { ok: true, outcome: 'already_applied' };
  const q = await query({ payRequestId: payment.providerRef, reference: payment.id });
  if (q.status === 'PENDING' || q.status === 'RECEIVED') return { ok: true, outcome: 'pending' };
  if (q.status === 'APPROVED' && q.amountCents !== payment.amountCents) {
    console.error('[paygate] amount mismatch', payment.id, q.amountCents, payment.amountCents);
    return { ok: false, reason: 'amount_mismatch' };
  }
  const status = q.status === 'APPROVED' ? 'COMPLETE' : q.status;
  // Claim the transition atomically so a concurrent notify/return can't apply it twice.
  const claimed = await prisma.payment.updateMany({ where: { id: payment.id, status: 'pending' }, data: { status, raw: q.data || null } });
  if (!claimed.count) return { ok: true, outcome: 'already_applied' };
  if (status !== 'COMPLETE') return { ok: true, outcome: status.toLowerCase() };
  return applyPaid(payment, q.data && q.data.TRANSACTION_ID);
}

// Money has been received for `payment` — update the booking.
async function applyPaid(payment, txId) {
  const { checkAvailability } = require('./sync');
  const { onBookingConfirmed } = require('./bookingConfirmed');
  const booking = await prisma.booking.findUnique({ where: { id: payment.bookingId }, include: { unit: { include: { property: true } } } });
  if (!booking) return { ok: true, outcome: 'booking_gone' };

  const total = booking.totalCents != null ? booking.totalCents : payment.amountCents;
  const paidSoFar = (booking.amountPaidCents || 0) + payment.amountCents;
  const owing = Math.max(0, total - paidSoFar);
  const money = {
    amountPaidCents: paidSoFar, amountOwingCents: owing,
    paid: owing === 0, paymentStatus: owing === 0 ? 'paid' : 'partial',
  };

  if (payment.kind === 'balance') {
    await prisma.booking.update({ where: { id: booking.id }, data: money });
    alertHost(booking, `💳 Balance paid — ${placeOf(booking)}\n👤 ${booking.guestName || 'Guest'} · ${booking.ref || ''}\nR${(payment.amountCents / 100).toFixed(2)} received via Paygate${owing ? ` · R${(owing / 100).toFixed(2)} still owing` : ' · fully paid'}`);
    return { ok: true, outcome: 'balance_paid' };
  }
  if (booking.status === 'confirmed') {
    await prisma.booking.update({ where: { id: booking.id }, data: money });
    return { ok: true, outcome: 'payment_recorded' };
  }
  if (booking.status === 'cancelled') {
    // Paid on an old payment page after the booking was cancelled — don't revive it.
    await prisma.booking.update({
      where: { id: booking.id },
      data: { ...money, comments: `${booking.comments || ''} · ⚠ PAID via Paygate (transaction ${txId || '?'}) after this booking was cancelled — refund the guest.` },
    });
    alertHost(booking, `⚠ Payment for a CANCELLED booking — ${placeOf(booking)}\n👤 ${booking.guestName || 'Guest'} · ${booking.ref || ''}\nR${(payment.amountCents / 100).toFixed(2)} received via Paygate. Refund the guest (or re-book them).`);
    return { ok: true, outcome: 'paid_but_cancelled' };
  }
  // The pending hold doesn't block the calendar, so re-check before confirming.
  const avail = await checkAvailability(booking.unitId, iso(booking.checkIn), iso(booking.checkOut), booking.id);
  if (!avail.available) {
    await prisma.booking.update({
      where: { id: booking.id },
      data: { ...money, comments: `${booking.comments || ''} · ⚠ PAID via Paygate (transaction ${txId || '?'}) but the dates were taken before payment completed — refund or move this guest.` },
    });
    alertHost(booking, `⚠ PAID but NOT confirmed — ${placeOf(booking)}\n👤 ${booking.guestName || 'Guest'} · ${booking.ref || ''}\nThe dates were booked by someone else while they were paying. Refund or move them.`);
    return { ok: true, outcome: 'paid_but_clash' };
  }
  await prisma.booking.update({ where: { id: booking.id }, data: { ...money, status: 'confirmed' } });
  try { await require('./locks').issueGuestCode({ ...booking, status: 'confirmed' }, booking.unit); } catch (e) { /* stubbed until smart locks are live */ }
  await onBookingConfirmed(booking.id); // host WhatsApp + "on confirmation" guest messages
  return { ok: true, outcome: 'confirmed' };
}

// Paygate's notify post: check it's signed with our key and is for one of our
// payments, then confirm the outcome with Paygate directly.
async function handleNotify(rawBody, opts = {}) {
  const c = paygate.config();
  if (!paygate.validPayload(rawBody)) return { ok: false, reason: 'bad_checksum' };
  const d = Object.fromEntries(new URLSearchParams(rawBody));
  if (d.PAYGATE_ID !== c.paygateId) return { ok: false, reason: 'wrong_merchant' };
  const payment = d.REFERENCE ? await prisma.payment.findUnique({ where: { id: d.REFERENCE } }) : null;
  if (!payment || payment.providerRef !== d.PAY_REQUEST_ID) return { ok: false, reason: 'unknown_payment' };
  return reconcile(payment, opts);
}

// For the guest's "confirming your payment…" screen: if the booking's latest
// payment is still pending, ask Paygate (in case the notify hasn't arrived).
async function reconcileBooking(bookingId, opts = {}) {
  if (!isOnline()) return null;
  const p = await prisma.payment.findFirst({ where: { bookingId, status: 'pending', providerRef: { not: null } }, orderBy: { createdAt: 'desc' } });
  if (!p || Date.now() - new Date(p.updatedAt).getTime() < 3000) return null; // don't hammer Paygate
  await prisma.payment.update({ where: { id: p.id }, data: { updatedAt: new Date() } });
  return reconcile(p, opts).catch((e) => { console.error('[paygate] reconcile failed', e.message); return null; });
}

// Card bookings whose payment was never completed hold no dates but clutter the
// board — cancel them after `hours`. EFT bookings (no online payment attempt)
// are left alone: the host confirms those by hand.
async function expireAbandoned({ hours = 24, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - hours * 3600 * 1000);
  const stale = await prisma.booking.findMany({
    where: {
      source: 'website', status: 'pending',
      payments: { some: {}, none: { OR: [{ status: 'COMPLETE' }, { createdAt: { gt: cutoff } }] } },
    },
    select: { id: true, comments: true },
  });
  for (const b of stale) {
    await prisma.booking.update({ where: { id: b.id }, data: { status: 'cancelled', comments: `${b.comments || ''} · Auto-cancelled: card payment not completed within ${hours}h.` } });
  }
  return stale.length;
}

// WhatsApp the host about a payment event (best-effort).
async function alertHost(booking, body) {
  try {
    const wa = require('./whatsapp');
    if (!wa.enabled()) return;
    const hostId = booking.hostId || booking.unit?.property?.hostId;
    const host = hostId && await prisma.host.findUnique({ where: { id: hostId }, select: { contactPhone: true, biller: { select: { phone: true } } } });
    const phone = host && (host.contactPhone || host.biller?.phone);
    if (phone) await wa.sendWhatsApp({ to: phone, body, contentSid: null });
  } catch (e) { console.error('[payments] host alert failed', e.message); }
}

module.exports = { createCheckout, verifyPayment, reconcile, reconcileBooking, handleNotify, expireAbandoned, isOnline, MODE };
