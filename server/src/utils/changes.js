// After a booking is confirmed: cancelling it with the refund its policy allows,
// and invoices for changes (new dates, late checkout, early check-in, an extra
// clean). A change invoice pays like any other, and only touches the booking and
// calendar once paid. Paygate takes refunds in its own portal, so here a refund
// is worked out and tracked, and the host marks it paid.
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const messaging = require('./messaging');
const offers = require('./offers');
const { alertHost } = require('./payments');
const { checkAvailability } = require('./sync');
const { quote } = require('./pricing');
const { overridesFor } = require('./nightPrices');
const { dateOnly } = require('./ical');
const { DEFAULT_CANCELLATION_POLICY } = require('./policy');

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const SAST_MS = 2 * 3600 * 1000;
const rand = (c) => `R${(c / 100).toFixed(2)}`;
const CANCELLABLE_STATUSES = ['confirmed', 'pending'];
const APPLIES = ['lateCheckOut', 'earlyCheckIn', 'clean'];
const BOOKING_WITH_PLACE = { unit: { include: { property: true } } };

const paidOn = (b) => (b.amountPaidCents != null ? b.amountPaidCents : (b.paid ? b.totalCents || 0 : 0));
const placeOf = (b) => [b.unit?.property?.name, b.unit?.name && `Unit ${b.unit.name}`].filter(Boolean).join(' · ') || 'your stay';

// The standard policy as numbers. A property with its own wording can't be worked
// out here, so percent is null and the host decides the refund.
function policyPercent(b, now) {
  const own = (b.unit?.property?.cancellationPolicy || '').trim();
  if (own && own !== DEFAULT_CANCELLATION_POLICY) return { percent: null, reason: 'This property has its own cancellation policy, so your host will confirm the refund.' };
  if (b.confirmedAt && now - new Date(b.confirmedAt) <= 3600 * 1000) return { percent: 100, reason: 'Cancelled within 1 hour of booking: full refund.' };
  const today = iso(new Date(now.getTime() + SAST_MS));
  const days = offers.nightsBetween(today, iso(b.checkIn));
  if (days >= 30) return { percent: 100, reason: 'Check-in is 30 days or more away: full refund.' };
  if (days >= 14) return { percent: 50, reason: 'Check-in is between 14 and 30 days away: 50% refund.' };
  return { percent: 0, reason: 'Check-in is less than 14 days away: non-refundable under the policy.' };
}

// A deposit held for breakage goes back in full whatever the policy allows.
function refundOn(b, percent) {
  const paid = paidOn(b);
  const deposit = b.depositStatus === 'held' ? Math.min(b.depositCents || 0, paid) : 0;
  return { paidCents: paid, depositCents: deposit, refundCents: percent == null ? null : deposit + Math.round((paid - deposit) * percent / 100) };
}

// The other units on this booking's invoices: they go when it goes.
async function extrasOf(b) {
  const invoices = await prisma.priceOffer.findMany({ where: { bookingId: b.id }, select: { id: true } });
  if (!invoices.length) return [];
  return prisma.booking.findMany({ where: { sourceOfferId: { in: invoices.map((o) => o.id) } }, include: BOOKING_WITH_PLACE });
}

function cancelBlock(b, by, stays, now) {
  if (!offers.INVOICEABLE_SOURCES.includes(b.source) || !b.unitId) return 'channel';
  if (!CANCELLABLE_STATUSES.includes(b.status)) return 'status';
  const today = iso(new Date(now.getTime() + SAST_MS));
  if (by === 'guest' && stays.some((s) => iso(s.checkIn) <= today)) return 'started';
  return null;
}

// What cancelling this booking would do, for both sides to see first.
async function cancelQuote(b, by = 'guest', now = new Date()) {
  const extras = (await extrasOf(b)).filter((x) => x.status !== 'cancelled');
  const stays = [b, ...extras];
  const rows = stays.map((s) => { const p = policyPercent(s, now); return { ...p, ...refundOn(s, p.percent) }; });
  const unknown = rows.some((r) => r.refundCents == null);
  return {
    blocked: cancelBlock(b, by, stays, now),
    places: stays.map(placeOf),
    paidCents: rows.reduce((n, r) => n + r.paidCents, 0),
    depositCents: rows.reduce((n, r) => n + r.depositCents, 0),
    refundCents: unknown ? null : rows.reduce((n, r) => n + r.refundCents, 0),
    percent: rows[0].percent, reason: rows[0].reason,
    policy: b.unit?.property?.cancellationPolicy || DEFAULT_CANCELLATION_POLICY,
  };
}

// Cancel and free the dates. The host may set the refund; a guest always gets the policy's.
async function cancelBooking(b, { by, refundCents = null, now = new Date() }) {
  const q = await cancelQuote(b, by, now);
  if (q.blocked) return { error: q.blocked, status: 409, message: q.blocked === 'started' ? 'This stay has already started. Please message your host.' : "This booking can't be cancelled here." };
  let refund = q.refundCents;
  if (by === 'host' && refundCents != null) {
    if (!Number.isInteger(refundCents) || refundCents < 0 || refundCents > q.paidCents) return { error: 'bad_refund', status: 400, message: `The refund must be between R0 and ${rand(q.paidCents)}.` };
    refund = refundCents;
  }
  const fields = { status: 'cancelled', cancelledAt: now, cancelledBy: by };
  const claimed = await prisma.booking.updateMany({
    where: { id: b.id, status: { in: CANCELLABLE_STATUSES } },
    data: { ...fields, refundDueCents: refund || null, refundedAt: null },
  });
  if (!claimed.count) return { error: 'status', status: 409, message: 'This booking has already been cancelled.' };
  const extras = (await extrasOf(b)).filter((x) => x.status !== 'cancelled');
  if (extras.length) await prisma.booking.updateMany({ where: { id: { in: extras.map((x) => x.id) } }, data: fields });

  const hostId = b.hostId || b.unit?.property?.hostId;
  if (by === 'guest') await prisma.message.create({ data: { hostId, bookingId: b.id, sender: 'guest', body: `I have cancelled this booking: ${q.places.join(', ')}.` } });
  const money = !q.paidCents ? '' : refund == null ? ' Your host will confirm your refund.' : refund > 0 ? ` A refund of ${rand(refund)} is due in line with the cancellation policy. Your host will pay it back and let you know.` : ' Under the cancellation policy, no refund is due.';
  await messaging.sendHostMessage(b.id, `This booking has been cancelled: ${q.places.join(', ')}.`, { notice: 'cancelled' });
  if (money) await messaging.sendHostMessage(b.id, money.trim(), { bookerOnly: true, notice: 'refund' });
  alertHost(b, `❌ Booking cancelled by ${by === 'guest' ? 'the guest' : 'you'}: ${q.places.join(', ')}\n👤 ${b.guestName || 'Guest'}${b.ref ? ` · ${b.ref}` : ''}\n${refund == null ? 'Refund: for you to decide' : `Refund due: ${rand(refund)}`}`);
  return { ok: true, refundCents: refund, places: q.places };
}

// The host has paid a refund back (in the Paygate portal, or by EFT).
async function markRefunded(b, refundCents, now = new Date()) {
  const extras = await extrasOf(b);
  const max = [b, ...extras].reduce((n, s) => n + paidOn(s), 0);
  if (!Number.isInteger(refundCents) || refundCents < 0 || refundCents > max) return { error: 'bad_refund', status: 400, message: `The refund must be between R0 and ${rand(max)}.` };
  if (b.status !== 'cancelled' && !b.refundDueCents) return { error: 'no_refund', status: 400, message: 'No refund is due on this booking.' };
  if (b.refundedAt) return { error: 'already_refunded', status: 409, message: 'This refund is already marked as paid.' };
  await prisma.booking.update({ where: { id: b.id }, data: { refundDueCents: refundCents, refundedAt: now } });
  if (refundCents > 0) await messaging.sendHostMessage(b.id, `Your refund of ${rand(refundCents)} has been paid.`, { bookerOnly: true, notice: 'refund' });
  return { ok: true };
}

// What the pricing sheet charges for a stay, before cleaning, fees and deposit:
// those stay the same when only the dates move.
async function sheetStayCents(rc, unitId, checkIn, checkOut) {
  const q = quote(rc, { checkIn, checkOut, cleans: 1, overrides: await overridesFor(unitId, checkIn, checkOut) });
  return q ? q.accommodationCents - q.discountCents : null;
}

// What new dates cost per the pricing sheet: new stay less current stay. Crossing
// into a length discount can make a longer stay cost less than a shorter one, so
// an extension bottoms out at free and a shorter stay never adds a charge.
// amountCents is null when the sheet can't price it, and the host types the amount.
async function changeQuote(b, checkIn, checkOut) {
  if (!offers.validDay(checkIn) || !offers.validDay(checkOut)) return { error: 'bad_dates', status: 400, message: 'Choose the new check-in and check-out dates.' };
  const nights = offers.nightsBetween(checkIn, checkOut);
  if (nights < 1 || nights > 365) return { error: 'bad_dates', status: 400, message: 'Check the new dates: check-out must be after check-in.' };
  const a = await checkAvailability(b.unitId, checkIn, checkOut, b.id);
  const available = !a.error && !!a.available;
  const rc = b.unit && b.unit.pricingGroupId ? await prisma.pricingGroup.findUnique({ where: { id: b.unit.pricingGroupId } }) : null;
  if (!rc || b.dayUse) return { available, nights, amountCents: null };
  const was = iso(b.checkIn), wasOut = iso(b.checkOut);
  const currentCents = await sheetStayCents(rc, b.unitId, was, wasOut);
  const newCents = await sheetStayCents(rc, b.unitId, checkIn, checkOut);
  if (currentCents == null || newCents == null) return { available, nights, amountCents: null };
  const wasNights = offers.nightsBetween(was, wasOut);
  const diff = newCents - currentCents;
  const amountCents = nights > wasNights ? Math.max(0, diff) : nights < wasNights ? Math.min(0, diff) : diff;
  return { available, nights, wasNights, currentCents, newCents, amountCents };
}

// Why this booking can't take a change invoice, or null if it can.
function changeBlock(b) {
  if (!offers.INVOICEABLE_SOURCES.includes(b.source)) return 'channel';
  if (!b.unitId) return 'no_unit';
  if (b.status !== 'confirmed') return 'status';
  if (!(b.guestEmail || b.guestAccountId)) return 'unreachable';
  return null;
}

// Validate a change invoice's lines; returns { lines, totalCents } or { error }.
async function cleanChangeLines(raw, b) {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Add at least one line.' };
  if (raw.length > 30) return { error: 'An invoice can have up to 30 lines.' };
  const lines = [];
  let dated = false;
  for (const l of raw) {
    const amountCents = Number(l && l.amountCents);
    if (!Number.isInteger(amountCents) || Math.abs(amountCents) > offers.MAX_LINE_CENTS) return { error: 'Check the amounts on this invoice.' };
    if (l.kind === 'change') {
      if (dated) return { error: 'Change the dates on one line only.' };
      dated = true;
      const { checkIn, checkOut } = l;
      if (!offers.validDay(checkIn) || !offers.validDay(checkOut)) return { error: 'Choose the new check-in and check-out dates.' };
      const nights = offers.nightsBetween(checkIn, checkOut);
      if (nights < 1 || nights > 365) return { error: 'Check the new dates: check-out must be after check-in.' };
      if (checkIn === iso(b.checkIn) && checkOut === iso(b.checkOut)) return { error: 'Those are the dates already on this booking.' };
      const a = await checkAvailability(b.unitId, checkIn, checkOut, b.id);
      if (a.error || !a.available) return { error: 'dates_unavailable' };
      lines.push({ kind: 'change', checkIn, checkOut, nights, amountCents, deposit: false, description: `New dates: ${offers.fmtDay(checkIn)} → ${offers.fmtDay(checkOut)} · ${nights} night${nights === 1 ? '' : 's'}` });
      continue;
    }
    let description = String((l && l.description) || '').trim().slice(0, 160);
    if (!description) return { error: 'Every line needs a description.' };
    const applies = APPLIES.includes(l.applies) ? l.applies : null;
    let cleanDate = null;
    if (applies === 'clean' && l.cleanDate) {
      if (!offers.validDay(l.cleanDate)) return { error: 'Check the date of the clean.' };
      cleanDate = l.cleanDate;
      description = `${description} (${offers.fmtDay(cleanDate)})`;
    }
    lines.push({ kind: 'charge', description, amountCents, deposit: false, applies, cleanDate });
  }
  return { lines, totalCents: lines.reduce((n, l) => n + l.amountCents, 0) };
}

// Send a change invoice. If there's nothing to pay it applies straight away, and
// anything owed back to the guest becomes a refund due.
async function sendChange(b, { lines: raw, note }) {
  const block = changeBlock(b);
  if (block) return { error: block, status: 400, message: "This booking can't be changed here." };
  const clean = await cleanChangeLines(raw, b);
  if (clean.error === 'dates_unavailable') return { error: 'dates_unavailable', status: 409, message: "Those dates aren't available on this unit, so nothing was sent." };
  if (clean.error) return { error: 'bad_lines', status: 400, message: clean.error };
  const offer = await prisma.$transaction(async (tx) => {
    await tx.priceOffer.updateMany({ where: { bookingId: b.id, status: 'open', kind: 'change' }, data: { status: 'replaced' } });
    return tx.priceOffer.create({
      data: {
        bookingId: b.id, kind: 'change', token: crypto.randomBytes(24).toString('base64url'),
        lines: clean.lines, totalCents: clean.totalCents, depositCents: 0,
        expiresAt: new Date(Date.now() + offers.OFFER_HOURS * 3600 * 1000),
      },
    });
  });
  const payable = clean.totalCents > 0;
  const body = String(note || '').trim().slice(0, 4000) || (payable ? 'Here is the invoice for the change to your booking. Your booking updates as soon as it is paid.' : 'I have updated your booking.');
  // With nothing to pay there's no invoice to email: applyChange tells them it's done.
  const sent = await messaging.sendHostMessage(b.id, body, { offer, noEmail: !payable });
  if (!sent.ok) return { error: sent.reason || 'send_failed', status: 400, message: "The invoice couldn't be sent." };
  if (!payable) await applyChange(offer, b, 0);
  return { offer: await prisma.priceOffer.findUnique({ where: { id: offer.id } }), message: sent.message, applied: !payable };
}

// Put a settled change on the booking. Runs once per invoice.
async function applyChange(offer, b, receivedCents) {
  const claimed = await prisma.priceOffer.updateMany({ where: { id: offer.id, status: { not: 'paid' } }, data: { status: 'paid', paidAt: new Date() } });
  if (!claimed.count) return { ok: true, outcome: 'already_applied' };
  const data = {};
  let clash = false;
  const lines = Array.isArray(offer.lines) ? offer.lines : [];
  for (const l of lines) {
    if (l.kind === 'change') {
      const a = await checkAvailability(b.unitId, l.checkIn, l.checkOut, b.id);
      if (a.error || !a.available) clash = true;
      else Object.assign(data, { checkIn: dateOnly(l.checkIn), checkOut: dateOnly(l.checkOut), dayUse: false });
    }
    if (l.applies === 'lateCheckOut') data.lateCheckOut = true;
    if (l.applies === 'earlyCheckIn') data.earlyCheckIn = true;
    if (l.applies === 'clean') await prisma.clean.create({ data: { bookingId: b.id, paymentMethod: 'prepaid', date: l.cleanDate ? dateOnly(l.cleanDate) : null } });
  }
  const paid = paidOn(b) + receivedCents;
  data.amountPaidCents = paid;
  // A manual booking holds its price in quotedCents only.
  const current = b.totalCents != null ? b.totalCents : b.quotedCents;
  if (current != null) {
    const total = current + offer.totalCents;
    const owing = Math.max(0, total - paid);
    Object.assign(data, { totalCents: total, quotedCents: total, amountOwingCents: owing, paid: owing === 0, paymentStatus: owing === 0 ? 'paid' : 'partial' });
  }
  if (offer.totalCents < 0) Object.assign(data, { refundDueCents: (b.refundedAt ? 0 : b.refundDueCents || 0) - offer.totalCents, refundedAt: null });
  if (clash) data.comments = `${b.comments || ''} · ⚠ Paid for new dates that were taken before payment completed. Refund or move this guest.`;
  await prisma.booking.update({ where: { id: b.id }, data });

  const what = lines.map((l) => l.description).join(', ');
  const refund = offer.totalCents < 0 ? ` A refund of ${rand(-offer.totalCents)} is due. Your host will pay it back and let you know.` : '';
  await messaging.sendHostMessage(b.id, clash ? 'Payment received, thanks. Those dates have since been taken, so your host will contact you to sort this out.' : `Your booking has been updated: ${what}.`, clash ? {} : { notice: 'changed' });
  if (refund && !clash) await messaging.sendHostMessage(b.id, refund.trim(), { bookerOnly: true, notice: 'refund' });
  alertHost(b, clash
    ? `⚠ Change PAID but dates taken: ${placeOf(b)}\n👤 ${b.guestName || 'Guest'}${b.ref ? ` · ${b.ref}` : ''}\nRefund or move them.`
    : `✏️ Booking changed: ${placeOf(b)}\n👤 ${b.guestName || 'Guest'}${b.ref ? ` · ${b.ref}` : ''}\n${what}${receivedCents ? `\n${rand(receivedCents)} received` : ''}`);
  return { ok: true, outcome: clash ? 'paid_but_clash' : 'changed' };
}

// Money has arrived for a change invoice (from payments.applyPaid).
async function applyPaidChange(payment, txId) {
  const offer = payment.offerId ? await prisma.priceOffer.findUnique({ where: { id: payment.offerId } }) : null;
  const b = await prisma.booking.findUnique({ where: { id: payment.bookingId }, include: BOOKING_WITH_PLACE });
  if (!b || !offer) return { ok: true, outcome: 'booking_gone' };
  if (b.status === 'cancelled') {
    // Paid on an old page after the booking was cancelled: all of it goes back.
    await prisma.priceOffer.update({ where: { id: offer.id }, data: { status: 'paid', paidAt: new Date() } });
    await prisma.booking.update({
      where: { id: b.id },
      data: {
        amountPaidCents: paidOn(b) + payment.amountCents, refundDueCents: (b.refundedAt ? 0 : b.refundDueCents || 0) + payment.amountCents, refundedAt: null,
        comments: `${b.comments || ''} · ⚠ Change invoice PAID via Paygate (transaction ${txId || '?'}) after this booking was cancelled. Refund the guest.`,
      },
    });
    alertHost(b, `⚠ Payment on a CANCELLED booking: ${placeOf(b)}\n👤 ${b.guestName || 'Guest'}${b.ref ? ` · ${b.ref}` : ''}\n${rand(payment.amountCents)} received. Refund the guest.`);
    return { ok: true, outcome: 'paid_but_cancelled' };
  }
  return applyChange(offer, b, payment.amountCents);
}

// The host has received an EFT for a change invoice.
async function markChangePaid(b, offerId) {
  const offer = await prisma.priceOffer.findFirst({ where: { id: offerId, bookingId: b.id, kind: 'change' } });
  if (!offer) return { error: 'not_found', status: 404, message: 'Invoice not found.' };
  if (offer.status !== 'open' || offer.totalCents <= 0) return { error: 'not_open', status: 409, message: 'This invoice is no longer waiting for payment.' };
  await prisma.payment.create({ data: { bookingId: b.id, kind: 'change', amountCents: offer.totalCents, provider: 'eft', status: 'COMPLETE', offerId: offer.id } });
  await applyPaidChange({ bookingId: b.id, offerId: offer.id, amountCents: offer.totalCents }, null);
  return { ok: true };
}

module.exports = { cancelQuote, cancelBooking, markRefunded, changeBlock, changeQuote, sendChange, applyPaidChange, markChangePaid };
