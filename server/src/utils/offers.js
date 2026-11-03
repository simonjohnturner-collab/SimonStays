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
const { dateOnly } = require('./ical');

const OFFER_HOURS = 48; // how long an invoice can be paid before the host must resend
const MAX_LINES = 30;
const MAX_LINE_CENTS = 100000000; // R1 000 000: catches a typo, not a real limit
const INVOICEABLE_SOURCES = ['website', 'manual']; // never channel bookings (Airbnb etc.)
const INVOICEABLE_STATUSES = ['enquiry', 'pending'];

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NIGHTS = 365;
const fmtDay = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const nightsBetween = (checkIn, checkOut) => Math.round((Date.parse(`${checkOut}T12:00:00Z`) - Date.parse(`${checkIn}T12:00:00Z`)) / 864e5);
const validDay = (s) => YMD.test(s || '') && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

// The accommodation lines of an invoice: what gets blocked once it's paid.
const staysOf = (offer) => (Array.isArray(offer.lines) ? offer.lines : []).filter((l) => l.kind === 'stay');
// The check-out to block with: a day-use line holds its date like one night.
const blockOut = (s) => (s.dayUse ? new Date(Date.parse(`${s.checkIn}T12:00:00Z`) + 864e5).toISOString().slice(0, 10) : s.checkOut);

// How the money splits across bookings. Each extra stay carries its own line and
// the first booking carries the rest (fees, deposit, discounts), so the bookings
// add up to the invoice. A discount bigger than that rest stays on the first booking.
function splitOf(offer) {
  const extras = staysOf(offer).slice(1);
  const extrasCents = extras.reduce((n, s) => n + s.amountCents, 0);
  const fits = offer.totalCents - extrasCents >= 0;
  return { extras, primaryCents: fits ? offer.totalCents - extrasCents : offer.totalCents, shareOf: (s) => (fits ? s.amountCents : 0) };
}

// Validate the host's lines; returns { lines, totalCents, depositCents } or { error }.
// Nights and amounts on a stay are worked out here, not taken from the browser.
// Check-in and check-out on the same date is day use, charged at the rate once.
async function cleanLines(raw, hostId) {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Add at least one line to the invoice.' };
  if (raw.length > MAX_LINES) return { error: `An invoice can have up to ${MAX_LINES} lines.` };
  const unitIds = raw.filter((l) => l && l.kind === 'stay' && l.unitId).map((l) => String(l.unitId));
  const units = await prisma.unit.findMany({ where: { id: { in: unitIds }, property: { hostId } }, include: { property: true } });
  const lines = [];
  for (const l of raw) {
    if (l && l.kind === 'stay') {
      const unit = units.find((u) => u.id === String(l.unitId));
      if (!unit) return { error: 'Choose a unit on every accommodation line.' };
      const { checkIn, checkOut } = l;
      const place = `${unit.property.name} · Unit ${unit.name}`;
      if (!validDay(checkIn) || !validDay(checkOut)) return { error: `Choose check-in and check-out dates for ${place}.` };
      const nights = nightsBetween(checkIn, checkOut);
      if (nights < 0 || nights > MAX_NIGHTS) return { error: `Check the dates for ${place}: check-out can't be before check-in.` };
      const nightlyCents = Number(l.nightlyCents);
      const dayUse = nights === 0;
      if (!Number.isInteger(nightlyCents) || nightlyCents < 0 || nightlyCents > MAX_LINE_CENTS) return { error: `Check the ${dayUse ? 'day' : 'nightly'} rate for ${place}.` };
      lines.push({
        kind: 'stay', unitId: unit.id, propertyName: unit.property.name, unitName: unit.name,
        checkIn, checkOut, nights, dayUse, nightlyCents, amountCents: dayUse ? nightlyCents : nights * nightlyCents, deposit: false,
        description: dayUse
          ? `${place}: ${fmtDay(checkIn)} · day use`
          : `${place}: ${fmtDay(checkIn)} → ${fmtDay(checkOut)} · ${nights} night${nights === 1 ? '' : 's'} @ R${(nightlyCents / 100).toFixed(2)}`,
      });
      continue;
    }
    const description = String((l && l.description) || '').trim().slice(0, 160);
    const amountCents = Number(l && l.amountCents);
    if (!description) return { error: 'Every line needs a description.' };
    if (!Number.isInteger(amountCents) || Math.abs(amountCents) > MAX_LINE_CENTS) return { error: `Check the amount on "${description}".` };
    lines.push({ kind: 'charge', description, amountCents, deposit: !!(l.deposit && amountCents > 0) });
  }
  const stays = lines.filter((l) => l.kind === 'stay');
  if (!stays.length) return { error: 'Add an accommodation line, so we know which unit and dates to block.' };
  for (let i = 0; i < stays.length; i++) {
    for (let j = i + 1; j < stays.length; j++) {
      const a = stays[i], b = stays[j];
      if (a.unitId === b.unitId && a.checkIn < blockOut(b) && b.checkIn < blockOut(a)) return { error: `Two lines overlap for ${a.propertyName} · Unit ${a.unitName}.` };
    }
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
function draftLines(q, b) {
  const stay = {
    kind: 'stay', unitId: b.unitId, checkIn: iso(b.checkIn), checkOut: iso(b.checkOut),
    nightlyCents: q ? Math.round(q.accommodationCents / q.nights) : 0,
  };
  if (!q) return [stay];
  const lines = [stay];
  const charge = (description, amountCents, deposit = false) => lines.push({ kind: 'charge', description, amountCents, deposit });
  if (q.discountCents) charge(`${q.discountPercent}% length discount`, -q.discountCents);
  if (q.cleaningCents) charge('Cleaning fee', q.cleaningCents);
  if (q.earlyCents) charge('Early check-in', q.earlyCents);
  if (q.lateCents) charge('Late checkout', q.lateCents);
  if (q.depositCents) charge('Refundable breakage deposit', q.depositCents, true);
  return lines;
}

// Start from the last invoice sent if it has accommodation lines, else the pricing sheet.
const draftFor = (lastOffer, q, b) => (lastOffer && staysOf(lastOffer).length ? lastOffer.lines : draftLines(q, b));

// Are all this invoice's units free? Returns the first stay that isn't, or null.
async function firstClash(stays, excludeBookingId) {
  for (const s of stays) {
    const a = await checkAvailability(s.unitId, s.checkIn, blockOut(s), excludeBookingId);
    if (a.error || !a.available) return s;
  }
  return null;
}

// Create or update the bookings for an invoice's extra units. Pending bookings
// (EFT) wait for the host; confirmed ones have been paid for.
async function saveExtraStays(offer, primary, status) {
  const { extras, shareOf } = splitOf(offer);
  const paid = status === 'confirmed';
  const saved = [];
  for (let i = 0; i < extras.length; i++) {
    const s = extras[i], share = shareOf(s);
    const checkIn = dateOnly(s.checkIn), checkOut = dateOnly(blockOut(s));
    const money = {
      status, totalCents: share, quotedCents: share, paid, paymentStatus: paid ? 'paid' : 'unpaid',
      amountPaidCents: paid ? share : 0, amountOwingCents: paid ? 0 : share,
    };
    const existing = await prisma.booking.findFirst({ where: { sourceOfferId: offer.id, unitId: s.unitId, checkIn } });
    saved.push(existing
      ? await prisma.booking.update({ where: { id: existing.id }, data: money })
      : await prisma.booking.create({
        data: {
          ...money, unitId: s.unitId, hostId: primary.hostId, source: 'website', sourceOfferId: offer.id, checkIn, checkOut, dayUse: !!s.dayUse,
          guestName: primary.guestName, guestEmail: primary.guestEmail, guestPhone: primary.guestPhone, guestAccountId: primary.guestAccountId,
          ref: primary.ref ? `${primary.ref}-${i + 2}` : null, termsAcceptedAt: primary.termsAcceptedAt,
          comments: `Second or later unit on invoice ${primary.ref || ''}`.trim(),
        },
      }));
  }
  return saved;
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
  // A change invoice is for a booking that's already confirmed and paid.
  if (offer.kind === 'change') {
    if (offer.status === 'paid' || offer.status === 'replaced') return offer.status;
    if (booking && booking.status === 'cancelled') return 'closed';
    return new Date(offer.expiresAt) <= now ? 'expired' : 'open';
  }
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
    id: offer.id, kind: offer.kind || 'booking', lines: offer.lines, totalCents: offer.totalCents, depositCents: offer.depositCents || 0,
    expiresAt: offer.expiresAt, state: offerState(offer, booking), link: offerLink(offer),
  };
}

// What a conversation costs: its paid invoice, else its latest, plus any paid changes.
function conversationCents(sent) {
  const invoices = sent.filter((o) => o.kind !== 'change');
  const base = invoices.find((o) => o.status === 'paid') || invoices[invoices.length - 1];
  if (!base) return null;
  return sent.filter((o) => o.kind === 'change' && o.status === 'paid').reduce((n, o) => n + o.totalCents, base.totalCents);
}

// Create the invoice, replace any earlier one, and message it to the guest.
async function sendOffer(booking, { lines: rawLines, note }) {
  const block = invoiceBlock(booking);
  if (block) return { error: block, status: 400, message: "This booking can't be sent an invoice." };
  const clean = await cleanLines(rawLines, booking.hostId || booking.unit.property.hostId);
  if (clean.error) return { error: 'bad_lines', status: 400, message: clean.error };
  const stays = clean.lines.filter((l) => l.kind === 'stay');
  const clash = await firstClash(stays, booking.id);
  if (clash) return { error: 'dates_unavailable', status: 409, message: `${clash.propertyName} · Unit ${clash.unitName} isn't available for those dates, so this invoice wasn't sent.` };

  const offer = await prisma.$transaction(async (tx) => {
    await tx.priceOffer.updateMany({ where: { bookingId: booking.id, status: 'open' }, data: { status: 'replaced' } });
    // Extra units held for an earlier invoice (EFT) go with it.
    const earlier = await tx.priceOffer.findMany({ where: { bookingId: booking.id }, select: { id: true } });
    await tx.booking.updateMany({ where: { sourceOfferId: { in: earlier.map((o) => o.id) }, status: 'pending' }, data: { status: 'cancelled' } });
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
        // The conversation follows the first accommodation line.
        unitId: stays[0].unitId, checkIn: dateOnly(stays[0].checkIn), checkOut: dateOnly(blockOut(stays[0])), dayUse: !!stays[0].dayUse,
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

module.exports = { OFFER_HOURS, MAX_LINE_CENTS, INVOICEABLE_SOURCES, fmtDay, nightsBetween, validDay, conversationCents, cleanLines, staysOf, blockOut, splitOf, firstClash, saveExtraStays, standardQuote, draftFor, invoiceBlock, offerState, offerLink, offerOut, sendOffer };
