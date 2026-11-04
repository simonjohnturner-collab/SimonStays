// What a guest paid for, line by line: the "Payment invoice" message they get when
// money arrives, and the breakdown on the admin portal's transactions.
const prisma = require('../lib/prisma');
const { quote } = require('./pricing');
const { overridesFor } = require('./nightPrices');
const messaging = require('./messaging');
const { sendMail } = require('./mailer');
const { threadLink } = require('./guestThread');
const { paperInvoiceEmail } = require('./paperInvoiceEmail');

const SPLIT_FEE_CENTS = 25000; // R250 admin fee for the 50/50 split plan
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const rand = (c) => `${c < 0 ? '-' : ''}R${(Math.abs(c) / 100).toFixed(2)}`;

// What each night cost, and why, as quoted.
const nightsOf = (q) => q.nightLines.map((n) => ({ date: n.date, cents: n.cents, weekend: !!n.weekend, flexPercent: n.flexPercent || 0, overridden: !!n.overridden }));

// A shopfront quote as lines. Saved on the booking when it's made.
function quoteLines(q, adminFeeCents = 0) {
  const lines = [];
  const add = (description, amountCents, deposit = false, extra = {}) => { if (amountCents) lines.push({ description, amountCents, deposit, ...extra }); };
  add(`${q.nights} night${q.nights === 1 ? '' : 's'} @ ${rand(q.avgNightlyCents)}`, q.accommodationCents, false, { nights: nightsOf(q) });
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

// This booking's stay at today's rate card, for one made before its lines were saved.
async function currentQuote(b) {
  const rc = b.unit && b.unit.pricingGroup;
  if (!rc) return null;
  const checkIn = iso(b.checkIn), checkOut = iso(b.checkOut);
  const overrides = await overridesFor(b.unitId, checkIn, checkOut).catch(() => null);
  return quote(rc, { checkIn, checkOut, cleans: 1, overrides, earlyCheckIn: !!b.earlyCheckIn, lateCheckOut: !!b.lateCheckOut });
}

// Rebuild the lines from the rate card, but only trust that if it adds up to what
// the guest was charged, as rates may have changed.
async function rebuiltLines(b, totalCents) {
  const q = await currentQuote(b);
  if (q) {
    const fee = totalCents - q.totalCents;
    if (fee === 0 || fee === SPLIT_FEE_CENTS) return quoteLines(q, fee);
  }
  const deposit = b.depositCents || 0;
  return [{ description: 'Accommodation and fees', amountCents: totalCents - deposit, deposit: false }, { description: 'Refundable breakage deposit', amountCents: deposit, deposit: true }].filter((l) => l.amountCents);
}

// `b` needs unit.pricingGroup. `offer` is the invoice it was paid on, if any.
async function breakdownOf(b, offer = null) {
  if (offer) return { lines: offerLines(offer), totalCents: offer.totalCents };
  if (Array.isArray(b.paymentLines) && b.paymentLines.length) {
    const lines = b.paymentLines;
    // Saved before each night's price was kept: add them if they still add up.
    if (lines[0].description.includes(' night') && !lines[0].nights) {
      const q = await currentQuote(b);
      if (q && q.accommodationCents === lines[0].amountCents) return { lines: [{ ...lines[0], nights: nightsOf(q) }, ...lines.slice(1)], totalCents: sum(lines) };
    }
    return { lines, totalCents: sum(lines) };
  }
  const totalCents = b.totalCents != null ? b.totalCents : b.quotedCents || 0;
  return { lines: totalCents ? await rebuiltLines(b, totalCents) : [], totalCents };
}

// An invoice's accommodation lines without their dates and nights: an invoice's
// dates can be adjusted to get it paid, and the booking holds the real stay.
const recordLines = (offer) => offer.lines.map((l) => ({
  description: l.kind === 'stay' ? `Accommodation: ${[l.propertyName, l.unitName && `Unit ${l.unitName}`].filter(Boolean).join(' · ') || 'your stay'}` : l.description,
  amountCents: l.amountCents,
}));

const dayOf = (d) => new Date(`${iso(d)}T00:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const nightNote = (n) => (n.overridden ? '' : [n.weekend && 'weekend rate', n.flexPercent > 0 && `+${n.flexPercent}% seasonal`].filter(Boolean).join(', '));

// The paper invoice for a booking, as an email. `b` needs BOOKING_INCLUDE and its paid offers.
async function invoiceEmailFor(b, { method, receivedCents = 0, link = threadLink(b.id) }) {
  const invoice = (b.offers || []).find((o) => o.kind !== 'change')
    || (b.sourceOfferId ? await prisma.priceOffer.findUnique({ where: { id: b.sourceOfferId } }) : null);
  const changes = (b.offers || []).filter((o) => o.kind === 'change');
  const base = invoice ? { lines: recordLines(invoice), totalCents: invoice.totalCents } : await breakdownOf(b);
  if (!base.lines.length) return null;
  const lines = [...base.lines, ...changes.flatMap(recordLines)].map((l) => ({
    ...l, nights: (l.nights || []).map((n) => ({ date: dayOf(n.date), cents: n.cents, note: nightNote(n) })),
  }));
  const totalCents = base.totalCents + changes.reduce((n, o) => n + o.totalCents, 0);
  const paidCents = invoice ? totalCents : Math.max(receivedCents, b.amountPaidCents || 0);
  const owingCents = invoice ? 0 : b.amountOwingCents || 0;
  const v = messaging.bookingValues(b);
  const made = paperInvoiceEmail({
    ref: b.ref, date: new Date(b.createdAt).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
    guestName: b.guestName, place: [v.property, v.unit && `Unit ${v.unit}`].filter(Boolean).join(' · '), address: v.address,
    checkIn: `${v.checkIn} from ${v.checkInTime}`, checkOut: b.dayUse ? '' : `${v.checkOut} by ${v.checkOutTime}`,
    lines, totalCents, method, paidCents, owingCents, link,
  });
  return {
    email: { subject: `Your SimonStays invoice${b.ref ? ` · ${b.ref}` : ''}`, ...made },
    summary: { lines, totalCents, paidCents, owingCents },
  };
}

const bookingForInvoice = (id) => prisma.booking.findUnique({
  where: { id },
  include: { ...messaging.BOOKING_INCLUDE, guestAccount: { select: { email: true } }, payments: { where: { status: 'COMPLETE' }, select: { id: true } }, offers: { where: { status: 'paid' }, orderBy: { createdAt: 'asc' } } },
});

// Money has arrived: tell the guest what they've paid for, in their conversation and
// by email. About money, so it only goes to the booker.
async function sendPaymentInvoice(bookingId, { method, receivedCents, offer = null }) {
  const b = await bookingForInvoice(bookingId);
  if (!b) return null;
  // An invoice paid just now may not be marked paid yet.
  if (offer && !b.offers.some((o) => o.id === offer.id)) b.offers.push(offer);
  const made = await invoiceEmailFor(b, { method, receivedCents });
  if (!made) return null;
  const { lines, totalCents, paidCents, owingCents } = made.summary;
  const body = [
    `Payment invoice${b.ref ? ` ${b.ref}` : ''}`,
    '',
    ...lines.map((l) => `${l.description}: ${rand(l.amountCents)}`),
    '',
    `Total: ${rand(totalCents)}`,
    `Paid by ${method}: ${rand(paidCents)}`,
    ...(owingCents > 0 ? [`Balance due: ${rand(owingCents)}`] : []),
  ].join('\n');
  return messaging.sendHostMessage(b.id, body, { bookerOnly: true, email: made.email });
}

// A copy of a guest's invoice for the admin to check, sent only to the admin. Its link
// opens the conversation without marking anything as read by the guest.
async function sendInvoicePreview(bookingId, to) {
  const b = await bookingForInvoice(bookingId);
  if (!b) return { error: 'not_found', status: 404, message: 'Booking not found.' };
  const made = await invoiceEmailFor(b, { method: b.payments.length ? 'card' : 'EFT', link: `${threadLink(b.id)}?preview=1` });
  if (!made) return { error: 'no_invoice', status: 400, message: 'This booking has no amounts to put on an invoice.' };
  const sent = await sendMail({ to, ...made.email, subject: `[Preview] ${made.email.subject}` });
  if (!sent) return { error: 'not_sent', status: 502, message: 'The email couldn’t be sent. Check the [mailer] lines in Render’s logs.' };
  return { ok: true, sentTo: to };
}

// The admin sends the guest their invoice, for their records. Answers { ok } or { error }.
async function sendBookingDetails(bookingId) {
  const b = await bookingForInvoice(bookingId);
  if (!b) return { error: 'not_found', status: 404, message: 'Booking not found.' };
  if (b.status !== 'confirmed' || !messaging.noticeable(b)) return { error: 'not_eligible', status: 400, message: 'This booking can’t be emailed: it needs to be confirmed, not finished, and have a guest email.' };
  const made = await invoiceEmailFor(b, { method: b.payments.length ? 'card' : 'EFT' });
  if (!made) return { error: 'no_invoice', status: 400, message: 'This booking has no amounts to put on an invoice.' };
  if (!(await sendMail({ to: messaging.bookerEmailOf(b), ...made.email }))) return { error: 'not_sent', status: 502, message: 'The email couldn’t be sent. Check the [mailer] lines in Render’s logs.' };
  const updated = await prisma.booking.update({ where: { id: b.id }, data: { detailsEmailedAt: new Date() }, select: { detailsEmailedAt: true } });
  return { ok: true, detailsEmailedAt: updated.detailsEmailedAt };
}

module.exports = { quoteLines, breakdownOf, offerLines, sendPaymentInvoice, sendBookingDetails, sendInvoicePreview };
