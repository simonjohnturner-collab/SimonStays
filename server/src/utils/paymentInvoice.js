// What a guest paid for, line by line: the "Payment invoice" message they get when
// money arrives, and the breakdown on the admin portal's transactions.
const prisma = require('../lib/prisma');
const { quote } = require('./pricing');
const { overridesFor } = require('./nightPrices');
const messaging = require('./messaging');

const SPLIT_FEE_CENTS = 25000; // R250 admin fee for the 50/50 split plan
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const rand = (c) => `${c < 0 ? '-' : ''}R${(Math.abs(c) / 100).toFixed(2)}`;

// A shopfront quote as lines. Saved on the booking when it's made.
function quoteLines(q, adminFeeCents = 0) {
  const lines = [];
  const add = (description, amountCents, deposit = false) => { if (amountCents) lines.push({ description, amountCents, deposit }); };
  add(`${q.nights} night${q.nights === 1 ? '' : 's'} @ ${rand(q.avgNightlyCents)}`, q.accommodationCents);
  add(`${q.discountPercent}% length discount`, -q.discountCents);
  add('Cleaning fee', q.cleaningCents);
  add('Early check-in', q.earlyCents);
  add('Late checkout', q.lateCents);
  add('Extra mattress', q.mattressCents);
  add('Refundable breakage deposit', q.depositCents, true);
  add('50/50 split admin fee', adminFeeCents);
  return lines;
}

const offerLines = (offer) => offer.lines.map((l) => ({ description: l.description, amountCents: l.amountCents, deposit: !!l.deposit }));
const sum = (lines) => lines.reduce((n, l) => n + l.amountCents, 0);

// A booking made before lines were saved: rebuild them from the rate card, but only
// trust that if it adds up to what the guest was charged, as rates may have changed.
async function rebuiltLines(b, totalCents) {
  const rc = b.unit && b.unit.pricingGroup;
  if (rc) {
    const checkIn = iso(b.checkIn), checkOut = iso(b.checkOut);
    const overrides = await overridesFor(b.unitId, checkIn, checkOut).catch(() => null);
    const q = quote(rc, { checkIn, checkOut, cleans: 1, overrides, earlyCheckIn: !!b.earlyCheckIn, lateCheckOut: !!b.lateCheckOut });
    const fee = q ? totalCents - q.totalCents : null;
    if (fee === 0 || fee === SPLIT_FEE_CENTS) return quoteLines(q, fee);
  }
  const deposit = b.depositCents || 0;
  return [{ description: 'Accommodation and fees', amountCents: totalCents - deposit, deposit: false }, { description: 'Refundable breakage deposit', amountCents: deposit, deposit: true }].filter((l) => l.amountCents);
}

// `b` needs unit.pricingGroup. `offer` is the invoice it was paid on, if any.
async function breakdownOf(b, offer = null) {
  if (offer) return { lines: offerLines(offer), totalCents: offer.totalCents };
  if (Array.isArray(b.paymentLines) && b.paymentLines.length) return { lines: b.paymentLines, totalCents: sum(b.paymentLines) };
  const totalCents = b.totalCents != null ? b.totalCents : b.quotedCents || 0;
  return { lines: totalCents ? await rebuiltLines(b, totalCents) : [], totalCents };
}

// Tell the guest what they've paid for. About money, so it only goes to the booker.
async function sendPaymentInvoice(bookingId, { method, receivedCents, offer = null }) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: { unit: { include: { pricingGroup: true } } } });
  if (!b) return null;
  const { lines, totalCents } = await breakdownOf(b, offer);
  if (!lines.length) return null;
  const owing = offer ? 0 : b.amountOwingCents || 0;
  const body = [
    `Payment invoice${b.ref ? ` ${b.ref}` : ''}`,
    '',
    ...lines.map((l) => `${l.description}: ${rand(l.amountCents)}`),
    '',
    `Total: ${rand(totalCents)}`,
    `Paid by ${method}: ${rand(receivedCents)}`,
    ...(owing > 0 ? [`Balance due: ${rand(owing)}`] : []),
  ].join('\n');
  return messaging.sendHostMessage(b.id, body, { bookerOnly: true, notice: 'invoice' });
}

module.exports = { quoteLines, breakdownOf, offerLines, sendPaymentInvoice };
