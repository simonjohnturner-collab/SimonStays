// Custom-priced invoices sent in a guest conversation. The host starts from the
// standard quote, edits or adds lines, and sends: the guest sees the invoice in
// the message and pays its total on a tokened page (/invoice/:token), no sign-in
// needed. Amounts always come from the stored offer, never from the browser.
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const messaging = require('./messaging');
const { checkAvailability } = require('./sync');
const { quote } = require('./pricing');
const { overridesFor } = require('./nightPrices');

const OFFER_HOURS = 48; // how long an invoice can be paid before the host must resend
const MAX_LINES = 30;
const MAX_LINE_CENTS = 100000000; // R1 000 000: catches a typo, not a real limit
const INVOICEABLE_SOURCES = ['website', 'manual']; // never channel bookings (Airbnb etc.)
const INVOICEABLE_STATUSES = ['enquiry', 'pending'];

const iso = (d) => new Date(d).toISOString().slice(0, 10);

// Validate the host's lines; returns { lines, totalCents, depositCents } or { error }.
function cleanLines(raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Add at least one line to the invoice.' };
  if (raw.length > MAX_LINES) return { error: `An invoice can have up to ${MAX_LINES} lines.` };
  const lines = [];
  for (const l of raw) {
    const description = String((l && l.description) || '').trim().slice(0, 160);
    const amountCents = Number(l && l.amountCents);
    if (!description) return { error: 'Every line needs a description.' };
    if (!Number.isInteger(amountCents) || Math.abs(amountCents) > MAX_LINE_CENTS) return { error: `Check the amount on "${description}".` };
    lines.push({ description, amountCents, deposit: !!(l.deposit && amountCents > 0) });
  }
  const totalCents = lines.reduce((n, l) => n + l.amountCents, 0);
  if (totalCents <= 0) return { error: 'The invoice total must be more than zero.' };
  const depositCents = lines.reduce((n, l) => n + (l.deposit ? l.amountCents : 0), 0);
  return { lines, totalCents, depositCents };
}

// What the pricing sheet says for this booking's dates, or null if unpriced.
async function standardQuote(b) {
  const rc = b.unit && b.unit.pricingGroup;
  if (!rc) return null;
  const checkIn = iso(b.checkIn), checkOut = iso(b.checkOut);
  const overrides = await overridesFor(b.unitId, checkIn, checkOut);
  return quote(rc, { checkIn, checkOut, cleans: 1, overrides, earlyCheckIn: !!b.earlyCheckIn, lateCheckOut: !!b.lateCheckOut });
}

// The lines the invoice editor opens with: the standard quote, itemised.
function draftLines(q) {
  if (!q) return [{ description: 'Accommodation', amountCents: 0 }];
  const lines = [{ description: `Accommodation · ${q.nights} night${q.nights === 1 ? '' : 's'}`, amountCents: q.accommodationCents }];
  if (q.discountCents) lines.push({ description: `${q.discountPercent}% length discount`, amountCents: -q.discountCents });
  if (q.cleaningCents) lines.push({ description: 'Cleaning fee', amountCents: q.cleaningCents });
  if (q.earlyCents) lines.push({ description: 'Early check-in', amountCents: q.earlyCents });
  if (q.lateCents) lines.push({ description: 'Late checkout', amountCents: q.lateCents });
  if (q.depositCents) lines.push({ description: 'Refundable breakage deposit', amountCents: q.depositCents, deposit: true });
  return lines;
}

// Why this booking can't take an invoice, or null if it can.
function invoiceBlock(b) {
  if (!INVOICEABLE_SOURCES.includes(b.source)) return 'channel';
  if (!b.unitId) return 'no_unit';
  if (!INVOICEABLE_STATUSES.includes(b.status)) return 'status';
  if (b.paid || (b.amountPaidCents || 0) > 0) return 'paid';
  if (!(b.guestEmail || b.guestAccountId)) return 'unreachable';
  return null;
}

// The offer's state as both sides should see it right now.
function offerState(offer, booking, now = new Date()) {
  if (offer.status === 'paid' || (booking && booking.paid)) return 'paid';
  if (offer.status === 'replaced') return 'replaced';
  if (booking && ['cancelled', 'confirmed'].includes(booking.status)) return 'closed';
  if (new Date(offer.expiresAt) <= now) return 'expired';
  return 'open';
}

function offerLink(offer) {
  const base = (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
  return `${base}/invoice/${offer.token}`;
}

function offerOut(offer, booking) {
  return {
    id: offer.id, lines: offer.lines, totalCents: offer.totalCents, depositCents: offer.depositCents || 0,
    expiresAt: offer.expiresAt, state: offerState(offer, booking), link: offerLink(offer),
  };
}

// Create the invoice, replace any earlier one, and message it to the guest.
async function sendOffer(booking, { lines: rawLines, note }) {
  const block = invoiceBlock(booking);
  if (block) return { error: block, status: 400, message: "This booking can't be sent an invoice." };
  const clean = cleanLines(rawLines);
  if (clean.error) return { error: 'bad_lines', status: 400, message: clean.error };
  const avail = await checkAvailability(booking.unitId, iso(booking.checkIn), iso(booking.checkOut), booking.id);
  if (avail.error || !avail.available) return { error: 'dates_unavailable', status: 409, message: "Those dates are no longer available, so this invoice wasn't sent." };

  const offer = await prisma.$transaction(async (tx) => {
    await tx.priceOffer.updateMany({ where: { bookingId: booking.id, status: 'open' }, data: { status: 'replaced' } });
    const created = await tx.priceOffer.create({
      data: {
        bookingId: booking.id, token: crypto.randomBytes(24).toString('base64url'),
        lines: clean.lines, totalCents: clean.totalCents, depositCents: clean.depositCents,
        expiresAt: new Date(Date.now() + OFFER_HOURS * 3600 * 1000),
      },
    });
    await tx.booking.update({
      where: { id: booking.id },
      data: {
        totalCents: clean.totalCents, quotedCents: clean.totalCents, depositCents: clean.depositCents || null,
        paymentStatus: 'unpaid', amountOwingCents: null,
      },
    });
    return created;
  });

  const body = String(note || '').trim().slice(0, 4000) || 'Here is your invoice. You can pay it securely using the link.';
  const sent = await messaging.sendHostMessage(booking.id, body, { offer });
  if (!sent.ok) return { error: sent.reason || 'send_failed', status: 400, message: "The invoice couldn't be sent." };
  return { offer, message: sent.message };
}

module.exports = { OFFER_HOURS, cleanLines, standardQuote, draftLines, invoiceBlock, offerState, offerLink, offerOut, sendOffer };
