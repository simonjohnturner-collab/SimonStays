// Refunding a held breakage deposit, from the admin portal's Refunds tab. Each
// refund is started, then approved by retyping its amount, then paid: a card
// payment is sent back through Paygate (PayHost), an EFT is paid by hand and
// marked paid with its bank reference.
//
// Sending to Paygate never repeats by itself. The refund is marked 'check' before
// the request goes out, so if the reply is unclear (or the server stops mid-call)
// it waits for someone to confirm with Paygate whether it went through.
const prisma = require('../lib/prisma');
const messaging = require('./messaging');
const paygate = require('./paygate');
const { shownCheckOut } = require('./ical');

const WAIT_DAYS = 7; // nothing is paid until this long after checkout
const SAST_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const rand = (c) => `R${(c / 100).toFixed(2)}`;
const paidOn = (b) => (b.amountPaidCents != null ? b.amountPaidCents : (b.paid ? b.totalCents || 0 : 0));
const dueOn = (b) => iso(new Date(shownCheckOut(b)).getTime() + WAIT_DAYS * DAY_MS);
const today = (now) => iso(now.getTime() + SAST_MS);
// What can go back: the deposit, or what was actually paid if that's less.
const refundableOf = (b) => Math.min(b.depositCents || 0, paidOn(b));

const INCLUDE = {
  unit: { include: { property: { select: { name: true, hostId: true } } } },
  payments: { where: { status: 'COMPLETE' } },
  depositRefund: true,
};

// Paygate (2026-11-12): a card payment can be refunded for 6 months. We stop a few
// days short so a refund is never sent on the last day and refused.
const CARD_REFUND_MONTHS = 6;
const CARD_REFUND_MARGIN_DAYS = 3;
function stillRefundable(p, now = new Date()) {
  const last = new Date(p.createdAt);
  last.setMonth(last.getMonth() + CARD_REFUND_MONTHS);
  return now.getTime() < last.getTime() - CARD_REFUND_MARGIN_DAYS * DAY_MS;
}

// Card payments a deposit could go back to: Paygate payments with a transaction ID.
function cardPayments(payments) {
  const sim = paygate.mode() === 'simulate';
  return payments.filter((p) => (p.provider === 'paygate' && p.raw && p.raw.TRANSACTION_ID) || (sim && p.provider === 'simulate'));
}
// The one to refund: still inside Paygate's 6 months, the largest (the deposit is
// charged with the stay, not the balance).
function cardPaymentOf(payments, now = new Date()) {
  const ok = cardPayments(payments).filter((p) => stillRefundable(p, now));
  return ok.sort((a, b) => b.amountCents - a.amountCents)[0] || null;
}
const txIdOf = (p) => (p && p.raw && p.raw.TRANSACTION_ID ? String(p.raw.TRANSACTION_ID) : p && p.provider === 'simulate' ? `SIM-${p.id}` : null);

// A booking's completed payments, or its invoice's when it's an invoice's extra unit.
async function paymentsOf(b) {
  const own = await prisma.payment.findMany({ where: { bookingId: b.id, status: 'COMPLETE' } });
  if (own.length || !b.sourceOfferId) return own;
  return prisma.payment.findMany({ where: { offerId: b.sourceOfferId, status: 'COMPLETE' } });
}

// Every deposit still held, and every refund already under way or paid. An invoice's
// extra units hold no payments of their own, so those are looked up by the invoice.
async function listRefunds({ hostId } = {}, now = new Date()) {
  const where = { depositCents: { gt: 0 }, OR: [{ status: 'confirmed', depositStatus: 'held' }, { depositRefund: { isNot: null } }] };
  if (hostId) where.AND = [{ OR: [{ hostId }, { unit: { property: { hostId } } }] }];
  const bookings = await prisma.booking.findMany({ where, include: INCLUDE, orderBy: { checkOut: 'asc' } });
  const offerIds = bookings.map((b) => b.sourceOfferId).filter(Boolean);
  const offerPayments = offerIds.length ? await prisma.payment.findMany({ where: { offerId: { in: offerIds }, status: 'COMPLETE' } }) : [];
  return bookings.map((b) => {
    const pays = b.payments.length ? b.payments : offerPayments.filter((p) => p.offerId === b.sourceOfferId);
    const card = pays[0];
    const toCard = cardPaymentOf(pays, now);
    return {
      bookingId: b.id, ref: b.ref || null,
      hostId: b.hostId || b.unit?.property?.hostId || null,
      property: b.unit?.property?.name || null, unit: b.unit?.name || null,
      guestName: b.guestName || null, guestEmail: b.guestEmail || null, guestPhone: b.guestPhone || null,
      checkOut: iso(shownCheckOut(b)), dueOn: dueOn(b), due: today(now) >= dueOn(b),
      depositCents: b.depositCents, refundableCents: refundableOf(b),
      method: card ? 'Card' : 'EFT',
      paygateRef: txIdOf(toCard) || (card && card.raw && card.raw.TRANSACTION_ID ? String(card.raw.TRANSACTION_ID) : null),
      // Can this refund go back to the card through Paygate?
      canSendToCard: !!toCard && paygate.refundsReady(),
      cardPaidCents: toCard ? toCard.amountCents : null,
      // Paid by card, but too long ago for Paygate to refund: it has to go by EFT.
      cardTooOld: !toCard && cardPayments(pays).length > 0,
      refund: b.depositRefund || null,
    };
  });
}

async function startRefund(bookingId, { amountCents, note }, by, now = new Date()) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: { depositRefund: true } });
  if (!b || !b.depositCents) return { error: 'not_found', status: 404, message: 'This booking has no deposit.' };
  if (b.status !== 'confirmed' || b.depositStatus !== 'held') return { error: 'not_held', status: 409, message: 'This deposit is no longer held.' };
  if (b.depositRefund) return { error: 'already_started', status: 409, message: 'A refund has already been started for this deposit.' };
  if (today(now) < dueOn(b)) return { error: 'not_due', status: 409, message: `This deposit can't be refunded before ${dueOn(b)}, ${WAIT_DAYS} days after checkout.` };
  const max = refundableOf(b);
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > max) return { error: 'bad_amount', status: 400, message: `The refund must be between R0.01 and ${rand(max)}.` };
  const reason = String(note || '').trim();
  if (amountCents < max && !reason) return { error: 'note_required', status: 400, message: 'Say why the refund is less than the deposit.' };
  try {
    return { refund: await prisma.depositRefund.create({ data: { bookingId, amountCents, note: reason || null, startedBy: by } }) };
  } catch (e) {
    if (e.code === 'P2002') return { error: 'already_started', status: 409, message: 'A refund has already been started for this deposit.' };
    throw e;
  }
}

// The sign-off: the amount is typed again and must match what was started.
async function approveRefund(id, { amountCents }, by, now = new Date()) {
  const r = await prisma.depositRefund.findUnique({ where: { id } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (amountCents !== r.amountCents) return { error: 'amount_mismatch', status: 400, message: `That doesn't match the refund of ${rand(r.amountCents)}.` };
  const claimed = await prisma.depositRefund.updateMany({ where: { id, status: 'started' }, data: { status: 'approved', approvedBy: by, approvedAt: now } });
  if (!claimed.count) return { error: 'not_started', status: 409, message: 'This refund is not waiting for approval.' };
  return { ok: true };
}

// Move a refund from `from` to paid, mark the deposit refunded and tell the guest.
async function finishPaid(r, from, data, now) {
  const done = await prisma.$transaction(async (tx) => {
    const claimed = await tx.depositRefund.updateMany({ where: { id: r.id, status: from }, data: { ...data, status: 'paid', paidAt: now } });
    if (!claimed.count) return false;
    await tx.booking.update({ where: { id: r.bookingId }, data: { depositStatus: 'refunded' } });
    return true;
  });
  if (!done) return false;
  const text = data.via === 'paygate'
    ? `Your deposit refund of ${rand(r.amountCents)} has been sent back to the card you paid with. It can take 7 to 14 days to show on your statement, or 14 to 21 days for a card issued outside South Africa.`
    : `Your deposit refund of ${rand(r.amountCents)} has been paid.`;
  await messaging.sendHostMessage(r.bookingId, text, { bookerOnly: true, notice: 'refund' })
    .catch((e) => console.error('[depositRefund] guest message failed', e.message));
  return true;
}

// Paid by hand (EFT, or in the Paygate portal), recorded with its reference.
async function markRefundPaid(id, { reference }, by, now = new Date()) {
  const ref = String(reference || '').trim();
  if (!ref) return { error: 'reference_required', status: 400, message: 'Enter the bank or Paygate reference for this payment.' };
  const r = await prisma.depositRefund.findUnique({ where: { id } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (!await finishPaid(r, 'approved', { reference: ref, paidBy: by, via: null }, now)) return { error: 'not_approved', status: 409, message: 'Only an approved refund can be marked as paid.' };
  return { ok: true };
}

// Send an approved refund back to the guest's card through Paygate.
async function sendToPaygate(id, by, now = new Date(), { refund = paygate.refund } = {}) {
  const r = await prisma.depositRefund.findUnique({ where: { id }, include: { booking: true } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (r.status !== 'approved') return { error: 'not_approved', status: 409, message: 'Only an approved refund can be sent to Paygate.' };
  if (!paygate.refundsReady()) return { error: 'not_set_up', status: 409, message: 'Paygate refunds are not set up yet (PayHost password missing). Pay this one by hand.' };
  const pays = await paymentsOf(r.booking);
  const pay = cardPaymentOf(pays, now);
  if (!pay) {
    if (cardPayments(pays).length) return { error: 'card_too_old', status: 409, message: `The card payment is more than ${CARD_REFUND_MONTHS} months old, so Paygate can't refund it. Pay this one by EFT.` };
    return { error: 'no_card_payment', status: 409, message: 'No Paygate card payment was found for this booking. Pay this one by hand.' };
  }
  // One card payment can cover several deposits (an invoice with several units).
  const others = await prisma.depositRefund.aggregate({ _sum: { amountCents: true }, where: { paymentId: pay.id, via: 'paygate', status: { in: ['check', 'paid'] }, id: { not: id } } });
  const left = pay.amountCents - (others._sum.amountCents || 0);
  if (r.amountCents > left) return { error: 'too_much', status: 409, message: `Only ${rand(Math.max(0, left))} of that card payment is left to refund.` };

  // Claim it first: from here on it is never sent again without a person checking.
  const claimed = await prisma.depositRefund.updateMany({ where: { id, status: 'approved' }, data: { status: 'check', via: 'paygate', paymentId: pay.id, sentBy: by, sentAt: now, lastError: null } });
  if (!claimed.count) return { error: 'not_approved', status: 409, message: 'This refund is already being sent.' };

  const out = await refund({ transactionId: txIdOf(pay), amountCents: r.amountCents });
  const reply = out.reply || null;
  if (out.outcome === 'sent') {
    await finishPaid(r, 'check', { reference: (reply && reply.transactionId) || 'Paygate', paidBy: by, via: 'paygate', paygate: reply }, now);
    return { ok: true, outcome: 'sent', message: `Paygate has the refund of ${rand(r.amountCents)} and passes it to the bank.` };
  }
  if (out.outcome === 'rejected') {
    await prisma.depositRefund.updateMany({ where: { id, status: 'check' }, data: { status: 'approved', via: null, paymentId: null, sentBy: null, sentAt: null, lastError: out.message, paygate: reply } });
    return { error: 'paygate_rejected', status: 502, message: `Paygate refused the refund, so no money moved: ${out.message}` };
  }
  await prisma.depositRefund.update({ where: { id }, data: { paygate: reply, lastError: out.message } });
  return { ok: true, outcome: 'unclear', message: `Paygate's reply was unclear (${out.message}). Check in the Paygate portal whether it went through before doing anything else.` };
}

// After checking with Paygate: it went through (with Paygate's reference), or it didn't.
async function resolveCheck(id, { outcome, reference }, by, now = new Date()) {
  const r = await prisma.depositRefund.findUnique({ where: { id } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (r.status !== 'check') return { error: 'not_check', status: 409, message: 'This refund is not waiting to be checked.' };
  if (outcome === 'went_through') {
    const ref = String(reference || '').trim();
    if (!ref) return { error: 'reference_required', status: 400, message: 'Enter the Paygate reference for the refund.' };
    if (!await finishPaid(r, 'check', { reference: ref, paidBy: by, via: 'paygate' }, now)) return { error: 'not_check', status: 409, message: 'This refund is not waiting to be checked.' };
    return { ok: true };
  }
  if (outcome === 'not_sent') {
    const back = await prisma.depositRefund.updateMany({ where: { id, status: 'check' }, data: { status: 'approved', via: null, paymentId: null, sentBy: null, sentAt: null, lastError: `Checked by ${by}: Paygate did not receive it.` } });
    if (!back.count) return { error: 'not_check', status: 409, message: 'This refund is not waiting to be checked.' };
    return { ok: true };
  }
  return { error: 'bad_outcome', status: 400, message: 'Say whether the refund went through.' };
}

// Called off before any money moves; the deposit simply stays held.
async function cancelRefund(id) {
  const gone = await prisma.depositRefund.deleteMany({ where: { id, status: { in: ['started', 'approved'] } } });
  if (!gone.count) return { error: 'not_cancellable', status: 409, message: 'A paid refund cannot be cancelled.' };
  return { ok: true };
}

module.exports = { WAIT_DAYS, listRefunds, startRefund, approveRefund, markRefundPaid, sendToPaygate, resolveCheck, cancelRefund, cardPaymentOf };
