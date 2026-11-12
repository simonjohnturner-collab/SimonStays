// Admin-only test refunds: send a small real refund through Paygate (PayHost)
// against any card payment, to prove the live connection end to end. Touches no
// booking or deposit; every attempt is kept in PaygateTestRefund.
const prisma = require('../lib/prisma');
const paygate = require('./paygate');

const MAX_CENTS = 5000; // R50 — this is a test, not a way to refund guests
const DAY_MS = 24 * 60 * 60 * 1000;
const rand = (c) => `R${(c / 100).toFixed(2)}`;
const txOf = (p) => (p.raw && p.raw.TRANSACTION_ID ? String(p.raw.TRANSACTION_ID) : null);

// Card payments from the last 6 months (cancelled bookings included), newest first,
// and the test refunds already tried.
async function listCardPayments() {
  const since = new Date(Date.now() - 183 * DAY_MS);
  const pays = await prisma.payment.findMany({
    where: { provider: 'paygate', status: 'COMPLETE', createdAt: { gte: since } },
    include: { booking: { select: { ref: true, guestName: true, guestEmail: true, status: true } } },
    orderBy: { createdAt: 'desc' }, take: 100,
  });
  const tests = await prisma.paygateTestRefund.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  return {
    maxCents: MAX_CENTS,
    ready: paygate.refundsReady() && paygate.mode() !== 'simulate',
    payments: pays.filter(txOf).map((p) => ({
      id: p.id, transactionId: txOf(p), amountCents: p.amountCents, createdAt: p.createdAt,
      ref: p.booking?.ref || null, guestName: p.booking?.guestName || null, guestEmail: p.booking?.guestEmail || null, bookingStatus: p.booking?.status || null,
    })),
    tests,
  };
}

async function sendTestRefund({ transactionId, amountCents }, by, { refund = paygate.refund } = {}) {
  const tx = String(transactionId || '').trim();
  if (!/^\d{4,20}$/.test(tx)) return { error: 'bad_tx', status: 400, message: 'Enter the Paygate transaction ID (digits only).' };
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > MAX_CENTS) return { error: 'bad_amount', status: 400, message: `A test refund must be between R0.01 and ${rand(MAX_CENTS)}.` };
  if (paygate.mode() === 'simulate' || !paygate.refundsReady()) return { error: 'not_set_up', status: 409, message: 'Paygate refunds are not set up on this server.' };
  // Not more than we have on record for that payment (Paygate checks this too).
  const local = (await prisma.payment.findMany({ where: { provider: 'paygate', status: 'COMPLETE' }, orderBy: { createdAt: 'desc' }, take: 500 })).find((p) => txOf(p) === tx);
  if (local && amountCents > local.amountCents) return { error: 'too_much', status: 400, message: `That payment was only ${rand(local.amountCents)}.` };
  // A double click must not send two refunds.
  const recent = await prisma.paygateTestRefund.findFirst({ where: { transactionId: tx, outcome: { in: ['sending', 'sent', 'unclear'] }, createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } } });
  if (recent) return { error: 'too_soon', status: 409, message: 'A test refund was just sent on this payment. Check the result below before trying again.' };

  const rec = await prisma.paygateTestRefund.create({ data: { transactionId: tx, paymentId: local ? local.id : null, amountCents, by, outcome: 'sending' } });
  const out = await refund({ transactionId: tx, amountCents });
  await prisma.paygateTestRefund.update({ where: { id: rec.id }, data: { outcome: out.outcome, message: out.message, reply: out.reply || undefined } });
  console.log(`[paygate] test refund ${rand(amountCents)} on ${tx} by ${by}: ${out.outcome} — ${out.message}`);
  return { ok: true, outcome: out.outcome, message: out.message, reply: out.reply || null };
}

module.exports = { MAX_CENTS, listCardPayments, sendTestRefund };
