// Refunding a held breakage deposit, from the admin portal's Refunds tab. Each
// refund is started, then approved by retyping its amount, then paid by hand (EFT,
// or in the Paygate portal for a card) and marked paid with its reference.
const prisma = require('../lib/prisma');
const messaging = require('./messaging');
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

// Every deposit still held, and every refund already under way or paid. An invoice's
// extra units hold no payments of their own, so those are looked up by the invoice.
async function listRefunds({ hostId } = {}, now = new Date()) {
  const where = { depositCents: { gt: 0 }, OR: [{ status: 'confirmed', depositStatus: 'held' }, { depositRefund: { isNot: null } }] };
  if (hostId) where.AND = [{ OR: [{ hostId }, { unit: { property: { hostId } } }] }];
  const bookings = await prisma.booking.findMany({ where, include: INCLUDE, orderBy: { checkOut: 'asc' } });
  const offerIds = bookings.map((b) => b.sourceOfferId).filter(Boolean);
  const offerPayments = offerIds.length ? await prisma.payment.findMany({ where: { offerId: { in: offerIds }, status: 'COMPLETE' } }) : [];
  return bookings.map((b) => {
    const card = (b.payments.length ? b.payments : offerPayments.filter((p) => p.offerId === b.sourceOfferId))[0];
    return {
      bookingId: b.id, ref: b.ref || null,
      hostId: b.hostId || b.unit?.property?.hostId || null,
      property: b.unit?.property?.name || null, unit: b.unit?.name || null,
      guestName: b.guestName || null, guestEmail: b.guestEmail || null, guestPhone: b.guestPhone || null,
      checkOut: iso(shownCheckOut(b)), dueOn: dueOn(b), due: today(now) >= dueOn(b),
      depositCents: b.depositCents, refundableCents: refundableOf(b),
      method: card ? 'Card' : 'EFT',
      paygateRef: card && card.raw && card.raw.TRANSACTION_ID ? String(card.raw.TRANSACTION_ID) : null,
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

async function markRefundPaid(id, { reference }, by, now = new Date()) {
  const ref = String(reference || '').trim();
  if (!ref) return { error: 'reference_required', status: 400, message: 'Enter the bank or Paygate reference for this payment.' };
  const r = await prisma.depositRefund.findUnique({ where: { id } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  const done = await prisma.$transaction(async (tx) => {
    const claimed = await tx.depositRefund.updateMany({ where: { id, status: 'approved' }, data: { status: 'paid', reference: ref, paidBy: by, paidAt: now } });
    if (!claimed.count) return false;
    await tx.booking.update({ where: { id: r.bookingId }, data: { depositStatus: 'refunded' } });
    return true;
  });
  if (!done) return { error: 'not_approved', status: 409, message: 'Only an approved refund can be marked as paid.' };
  await messaging.sendHostMessage(r.bookingId, `Your deposit refund of ${rand(r.amountCents)} has been paid.`, { bookerOnly: true, notice: 'refund' })
    .catch((e) => console.error('[depositRefund] guest message failed', e.message));
  return { ok: true };
}

// Called off before any money moves; the deposit simply stays held.
async function cancelRefund(id) {
  const gone = await prisma.depositRefund.deleteMany({ where: { id, status: { in: ['started', 'approved'] } } });
  if (!gone.count) return { error: 'not_cancellable', status: 409, message: 'A paid refund cannot be cancelled.' };
  return { ok: true };
}

module.exports = { WAIT_DAYS, listRefunds, startRefund, approveRefund, markRefundPaid, cancelRefund };
