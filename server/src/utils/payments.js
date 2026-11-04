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
// `returnTo` is the app's deep link (see appReturn) — after paying, the guest is
// sent back into the app instead of the website.
async function createCheckout(booking, amountCents, { base, kind = 'booking', returnTo = null, offerId = null } = {}) {
  if (!isOnline() || !base) return { mode: 'simulate', amountCents };
  const b = booking.unit ? booking : await prisma.booking.findUnique({ where: { id: booking.id }, include: { unit: { include: { property: true } } } });
  const payment = await prisma.payment.create({ data: { bookingId: b.id, kind, amountCents, provider: 'paygate', returnTo: appReturn(returnTo), offerId } });
  const init = await paygate.initiate({
    reference: payment.id, amountCents, email: await emailFor(b), user1: kind,
    returnUrl: `${base}/public/paygate/return/${payment.id}`,
    notifyUrl: `${base}/public/paygate/notify`,
  });
  await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: init.payRequestId } });
  return { mode: 'form', paymentId: payment.id, amountCents, ...init.form, goUrl: `${base}/public/paygate/go/${payment.id}` };
}

// Only the SimonStays app's own link schemes may be a return target (never a
// web address — that would be an open redirect). exp:// is Expo Go in testing.
function appReturn(url) {
  const u = String(url || '').trim();
  return /^(simonstays|exp|exps):\/\/[^\s"'<>]{0,300}$/i.test(u) ? u : null;
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
  if (payment.kind === 'change') return require('./changes').applyPaidChange(payment, txId);
  const { checkAvailability } = require('./sync');
  const { onBookingConfirmed } = require('./bookingConfirmed');
  let booking = await prisma.booking.findUnique({ where: { id: payment.bookingId }, include: { unit: { include: { property: true } } } });
  if (!booking) return { ok: true, outcome: 'booking_gone' };
  const offers = require('./offers');
  const offer = payment.offerId ? await prisma.priceOffer.findUnique({ where: { id: payment.offerId } }) : null;
  if (offer) booking = await applyOfferTerms(offer, booking);
  // On an invoice with several units, the rest of the money belongs to the extra bookings.
  const extraCents = offer ? offer.totalCents - offers.splitOf(offer).primaryCents : 0;

  const total = booking.totalCents != null ? booking.totalCents : payment.amountCents;
  const paidSoFar = (booking.amountPaidCents || 0) + payment.amountCents - extraCents;
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
  const extraClash = offer ? await offers.firstClash(offers.staysOf(offer).slice(1), booking.id) : null;
  if (!avail.available || extraClash) {
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
  // Every other unit on the invoice is blocked and confirmed the same way.
  const extraBookings = offer ? await offers.saveExtraStays(offer, booking, 'confirmed') : [];
  for (const extra of extraBookings) {
    const full = await prisma.booking.findUnique({ where: { id: extra.id }, include: { unit: { include: { property: true } } } });
    try { await require('./locks').issueGuestCode(full, full.unit); } catch (e) { /* stubbed until smart locks are live */ }
    await onBookingConfirmed(extra.id);
  }
  return { ok: true, outcome: 'confirmed' };
}

// The host has seen an EFT reach their account: confirm the booking. Mirrors what a
// card payment does, including re-checking the dates, since a pending booking
// doesn't hold them. The guest is told in their thread, and by email.
async function confirmByHost(bookingId) {
  const { checkAvailability } = require('./sync');
  const { onBookingConfirmed } = require('./bookingConfirmed');
  const offers = require('./offers');
  const messaging = require('./messaging');
  let booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { unit: { include: { property: true } } } });
  if (!booking || booking.status !== 'pending' || !booking.unitId) return { error: 'not_pending', status: 409, message: 'Only a booking awaiting payment can be confirmed.' };

  // An invoice the guest chose to pay by EFT sets the dates and the units.
  const offer = await prisma.priceOffer.findFirst({ where: { bookingId, status: 'open', kind: { not: 'change' } }, orderBy: { createdAt: 'desc' } });
  const stays = offer ? offers.staysOf(offer) : [];
  if (stays.length) {
    const clash = await offers.firstClash(stays, bookingId);
    if (clash) return { error: 'dates_unavailable', status: 409, message: `${clash.propertyName} · Unit ${clash.unitName} has since been booked for those dates. Refund or move this guest.` };
  } else {
    const avail = await checkAvailability(booking.unitId, iso(booking.checkIn), iso(booking.checkOut), booking.id);
    if (!avail.available) return { error: 'dates_unavailable', status: 409, conflicts: avail.conflicts, message: 'Those dates have since been booked. Refund or move this guest.' };
  }

  if (offer) booking = await applyOfferTerms(offer, booking);
  const total = booking.quotedCents != null ? booking.quotedCents : booking.totalCents;
  // A 50/50 split keeps its balance owing; anything else is now paid in full.
  const balance = booking.paymentStatus === 'partial' ? (booking.amountOwingCents || 0) : 0;
  const money = balance > 0
    ? { amountPaidCents: booking.amountPaidCents || Math.max(0, (total || 0) - balance), amountOwingCents: balance, paid: false, paymentStatus: 'partial' }
    : { amountPaidCents: total, amountOwingCents: 0, paid: true, paymentStatus: 'paid' };
  const claimed = await prisma.booking.updateMany({ where: { id: booking.id, status: 'pending' }, data: { ...money, quotedCents: total, status: 'confirmed' } });
  if (!claimed.count) return { error: 'not_pending', status: 409, message: 'Only a booking awaiting payment can be confirmed.' };

  try { await require('./locks').issueGuestCode({ ...booking, status: 'confirmed' }, booking.unit); } catch (e) { /* stubbed until smart locks are live */ }
  await onBookingConfirmed(booking.id);
  const extraBookings = offer ? await offers.saveExtraStays(offer, booking, 'confirmed') : [];
  for (const extra of extraBookings) {
    const full = await prisma.booking.findUnique({ where: { id: extra.id }, include: { unit: { include: { property: true } } } });
    try { await require('./locks').issueGuestCode(full, full.unit); } catch (e) { /* stubbed until smart locks are live */ }
    await onBookingConfirmed(extra.id);
  }
  if (booking.guestEmail || booking.guestAccountId) {
    const dates = `${iso(booking.checkIn)} to ${iso(booking.checkOut)}`;
    await messaging.sendHostMessage(booking.id, `We've received your payment, thank you. Your booking${booking.ref ? ` ${booking.ref}` : ''} at ${placeOf(booking)}, ${dates}, is confirmed.${balance > 0 ? ` The balance of R${(balance / 100).toFixed(2)} is due at least 3 days before check-in.` : ''}`, { bookerOnly: balance > 0, noEmail: true }) // onBookingConfirmed has emailed them
      .catch((e) => console.error('[confirm] guest message failed', booking.id, e.message));
  }
  return { ok: true, booking: await prisma.booking.findUnique({ where: { id: booking.id } }) };
}

// The guest paid this invoice, so its terms stand even if a newer one was sent
// while they were on the payment page: they owe what they were shown.
async function applyOfferTerms(offer, booking) {
  const { staysOf, blockOut, splitOf } = require('./offers');
  const { dateOnly } = require('./ical');
  const first = staysOf(offer)[0];
  const share = splitOf(offer).primaryCents;
  await prisma.priceOffer.update({ where: { id: offer.id }, data: { status: 'paid', paidAt: new Date() } });
  return prisma.booking.update({
    where: { id: booking.id },
    data: {
      ...(first ? { unitId: first.unitId, checkIn: dateOnly(first.checkIn), checkOut: dateOnly(blockOut(first)), dayUse: !!first.dayUse } : {}),
      totalCents: share, quotedCents: share,
      depositCents: offer.depositCents || null, depositStatus: offer.depositCents ? 'held' : null,
    },
    include: { unit: { include: { property: true } } },
  });
}

// Local testing only: settle an invoice with no gateway configured. The route
// refuses this on Render, so it can never confirm a real stay without payment.
async function completeSimulatedOffer(offer, booking) {
  const payment = await prisma.payment.create({ data: { bookingId: booking.id, kind: offer.kind === 'change' ? 'change' : 'booking', amountCents: offer.totalCents, provider: 'simulate', status: 'COMPLETE', offerId: offer.id } });
  return applyPaid(payment, null);
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
      offers: { none: { status: 'open', expiresAt: { gt: now } } }, // an unexpired invoice is still payable
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

module.exports = { alertHost, confirmByHost, completeSimulatedOffer, appReturn, createCheckout, verifyPayment, reconcile, reconcileBooking, handleNotify, expireAbandoned, isOnline, MODE };
