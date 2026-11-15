// The guestbook (/guestbook): a guest fills in their own details for an upcoming
// stay — name, contact, extras and special instructions — and gets a SimonStays
// account in the same step. Built mainly for Airbnb guests, who arrive from a
// link in an Airbnb message that's the same for everyone, so the booking is
// found by name rather than a personal link.
//
// Guests can also search by their booking code (Airbnb's HM… code or our ref).
// Results show the dates, building and unit, as the host wants guests to
// recognise their stay at a glance. A booking is only linked to the guest's
// account (which shows the door code) when the phone they give matches the
// last 4 digits Airbnb sent us. Otherwise the details are saved and the host
// links the account by hand.
const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { Prisma } = require('@prisma/client');
const { optionalGuest } = require('../middleware/auth');
const { signGuest } = require('../lib/jwt');
const payments = require('../utils/payments');
const { alertHost } = payments;
const { eftFor } = require('../utils/eft');
const { shownCheckOut } = require('../utils/ical');

const router = express.Router();
router.use(optionalGuest);

const DAY = 864e5;
const LOOK_AHEAD_DAYS = 120; // bookings starting this far ahead can be found
const MAX_RESULTS = 5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const fmtR = (c) => `R${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
const fmtDay = (d) => new Date(d).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const clean = (s, max = 200) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
// Lower case, no accents, letters only: "José" ↔ "jose".
const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');

// Per-IP limit on searches and submissions, so names can't be trawled.
const hits = new Map();
function overLimit(key, max, windowMs = 60 * 60 * 1000) {
  const now = Date.now(), cutoff = now - windowMs;
  const list = (hits.get(key) || []).filter((t) => t > cutoff);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => t > cutoff)) hits.delete(k);
  return false;
}
const tooMany = (res) => res.status(429).json({ error: 'too_many', message: 'Too many tries. Please wait a little and try again.' });

const BOOKING_INCLUDE = { unit: { include: { pricingGroup: true, property: { select: { id: true, name: true, hostId: true } } } } };

// Upcoming or current stays: confirmed, not over, starting within the window.
function openWhere() {
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  return { status: 'confirmed', unitId: { not: null }, checkOut: { gte: today }, checkIn: { lte: new Date(today.getTime() + LOOK_AHEAD_DAYS * DAY) } };
}

// Does the name typed match the booking's? First names must match; a surname is
// only checked when the booking has one (Airbnb often gives a first name only).
function nameMatches(booking, firstName, surname) {
  const parts = norm(booking.guestName).split(' ').filter(Boolean);
  if (!parts.length || parts[0] !== norm(firstName).split(' ')[0]) return false;
  const sur = norm(surname);
  if (parts.length > 1 && sur) return parts.slice(1).some((p) => p === sur || p.startsWith(sur) || sur.startsWith(p));
  return true;
}

// The paid and free extras on offer for this stay, priced from its rate card.
function extrasOf(b) {
  const g = (b.unit && b.unit.pricingGroup) || {};
  return [
    { key: 'earlyCheckIn', label: 'Early check-in', cents: g.earlyCheckInCents || 0 },
    { key: 'lateCheckOut', label: 'Late check-out', cents: g.lateCheckOutCents || 0 },
    { key: 'extraMattress', label: 'Extra mattress', cents: g.mattressCents || 0 },
    { key: 'hairDryer', label: 'Hair dryer', cents: 0 },
  ];
}

// Mid-stay cleans: any day after check-in and before check-out, at the rate
// card's in-stay clean price (or the unit clean price when none is set).
// Null for a stay too short to have one.
function instayOf(b) {
  const first = new Date(new Date(b.checkIn).getTime() + DAY), last = new Date(shownCheckOut(b).getTime() - DAY);
  if (iso(first) > iso(last)) return null;
  const g = (b.unit && b.unit.pricingGroup) || {};
  return { cents: g.instayCleanCents || g.cleaningCents || 0, from: iso(first), to: iso(last) };
}
const requestedOf = (b) => (Array.isArray(b.requestedCleans) ? b.requestedCleans.filter((d) => typeof d === 'string') : []);

// What the guest sees of a booking: its dates, place and what can be added.
function stayOut(b, mine = false) {
  const out = {
    id: b.id, checkIn: iso(b.checkIn), checkOut: iso(shownCheckOut(b)),
    nights: Math.max(1, Math.round((shownCheckOut(b) - new Date(b.checkIn)) / DAY)),
    label: `${fmtDay(b.checkIn)} → ${fmtDay(shownCheckOut(b))}`,
    channel: b.source === 'airbnb' ? 'airbnb' : 'simonstays',
    extras: extrasOf(b),
    done: !!b.guestbookAt,
    instayClean: instayOf(b),
    payMethods: payMethodsFor(b),
    place: b.unit ? `${b.unit.property.name} · Unit ${b.unit.name}` : null,
  };
  // Their own trip (signed in): what's already on file.
  if (mine) {
    Object.assign(out, {
      current: {
        earlyCheckIn: b.earlyCheckIn, lateCheckOut: b.lateCheckOut, extraMattress: b.extraMattress, hairDryer: b.hairDryer, notes: b.guestNotes || '', cleans: requestedOf(b),
        // Already on the booking and not to be charged again (host-added or paid).
        have: { earlyCheckIn: haveExtra(b, 'earlyCheckIn'), lateCheckOut: haveExtra(b, 'lateCheckOut'), extraMattress: haveExtra(b, 'extraMattress'), hairDryer: haveExtra(b, 'hairDryer') },
        paidCleans: paidCleansOf(b),
      },
    });
  }
  return out;
}

// A booking already linked to someone else's account is theirs to edit.
const lockedTo = (b, acct) => !!(b.guestbookAt && b.guestAccountId && (!acct || acct.id !== b.guestAccountId));

// A booking code typed by the guest: Airbnb's confirmation code or our ref.
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
const codeMatches = (b, code) => !!code && code.length >= 5 && [b.resCode, b.ref].some((c) => c && String(c).toUpperCase() === code);

// POST /public/guestbook/find { firstName, surname } or { code } → the matching stays.
router.post('/find', async (req, res, next) => {
  try {
    if (overLimit(`find:${req.ip}`, 20)) return tooMany(res);
    const firstName = clean((req.body || {}).firstName, 60);
    const surname = clean((req.body || {}).surname, 60);
    const code = cleanCode((req.body || {}).code);
    if (code) {
      if (code.length < 5) return res.status(400).json({ error: 'code_invalid', message: 'Please check your booking code.' });
      const rows = await prisma.booking.findMany({
        where: { ...openWhere(), OR: [{ resCode: { equals: code, mode: 'insensitive' } }, { ref: { equals: code, mode: 'insensitive' } }] },
        include: BOOKING_INCLUDE, take: MAX_RESULTS,
      });
      const acct = req.guestId ? { id: req.guestId } : null;
      return res.json({ stays: rows.filter((b) => !lockedTo(b, acct)).map((b) => stayOut(b)) });
    }
    if (norm(firstName).length < 2) return res.status(400).json({ error: 'name_required', message: 'Please enter your first name, or your booking code.' });
    const first = norm(firstName).split(' ')[0];
    // Narrow in the database by the first name's start, then match properly here.
    const rows = await prisma.booking.findMany({
      where: { ...openWhere(), guestName: { contains: firstName.split(' ')[0].slice(0, 3), mode: 'insensitive' } },
      include: BOOKING_INCLUDE, orderBy: { checkIn: 'asc' }, take: 200,
    });
    const acct = req.guestId ? { id: req.guestId } : null;
    const stays = rows.filter((b) => nameMatches(b, first, surname) && !lockedTo(b, acct)).slice(0, MAX_RESULTS).map((b) => stayOut(b));
    res.json({ stays });
  } catch (e) { next(e); }
});

// GET /public/guestbook/mine — a signed-in guest's own upcoming stays.
router.get('/mine', async (req, res, next) => {
  try {
    if (!req.guestId) return res.status(401).json({ error: 'sign_in_required' });
    const acct = await prisma.guestAccount.findUnique({ where: { id: req.guestId } });
    if (!acct) return res.status(401).json({ error: 'sign_in_required' });
    const or = [{ guestAccountId: acct.id }];
    if (acct.emailVerifiedAt) or.push({ guestEmail: { equals: acct.email, mode: 'insensitive' } });
    const rows = await prisma.booking.findMany({ where: { ...openWhere(), OR: or }, include: BOOKING_INCLUDE, orderBy: { checkIn: 'asc' }, take: 10 });
    const name = String(acct.name || '').trim().split(/\s+/);
    res.json({ stays: rows.map((b) => stayOut(b, true)), account: { firstName: name[0] || '', surname: name.slice(1).join(' '), email: acct.email, phone: acct.phone || '' } });
  } catch (e) { next(e); }
});

// What's already on the booking, so it isn't charged again: extras the host
// added or that were paid, not ones from an earlier guestbook still unpaid.
function unpaidItems(b) { return !b.extrasPaidAt && Array.isArray(b.extrasItems) ? b.extrasItems : []; }
function haveExtra(b, key) { return !!b[key] && !unpaidItems(b).some((l) => l.key === key); }
// Requested cleans already paid for: any not in an unpaid request.
function paidCleansOf(b) { const unpaid = new Set(unpaidItems(b).map((l) => l.date).filter(Boolean)); return requestedOf(b).filter((d) => !unpaid.has(d)); }

// How a guest can pay for extras: Airbnb's own payment request (Airbnb
// bookings only), card through Paygate (when it's switched on), or EFT.
function payMethodsFor(b) {
  return [...(b.source === 'airbnb' ? ['airbnb'] : []), ...(payments.isOnline() ? ['card'] : []), 'eft'];
}
const PAY_LABEL = { airbnb: 'payment request through Airbnb', card: 'card', eft: 'EFT' };
const payRef = (b) => b.ref || b.resCode || b.id.slice(0, 8).toUpperCase();
// PAYMENT_BASE_URL overrides it — Paygate refuses non-public addresses like localhost.
const siteBase = (req) => (process.env.PAYMENT_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// POST /public/guestbook/:id — save the guestbook for one stay.
// { firstName, surname, email, phone, password?, code?, extras: {earlyCheckIn,…},
//   cleans: ['YYYY-MM-DD'], notes, agreeCharges, payMethod: 'airbnb'|'card'|'eft' }
router.post('/:id', async (req, res, next) => {
  try {
    if (overLimit(`save:${req.ip}`, 15)) return tooMany(res);
    const body = req.body || {};
    const firstName = clean(body.firstName, 60), surname = clean(body.surname, 60);
    const email = clean(body.email, 120).toLowerCase(), phone = clean(body.phone, 30);
    const notes = String(body.notes || '').replace(/\r/g, '').trim().slice(0, 1500) || null;
    if (!firstName || !surname) return res.status(400).json({ error: 'name_required', message: 'Please enter your first name and surname.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'email_required', message: 'Please enter a valid email address.' });
    if (digits(phone).length < 9) return res.status(400).json({ error: 'phone_required', message: 'Please enter your mobile number, with the country code if outside South Africa.' });

    const b = await prisma.booking.findFirst({ where: { id: String(req.params.id), ...openWhere() }, include: BOOKING_INCLUDE });
    if (!b) return res.status(404).json({ error: 'not_found', message: 'We couldn’t find that stay. It may have ended or been cancelled.' });

    let acct = req.guestId ? await prisma.guestAccount.findUnique({ where: { id: req.guestId } }) : null;
    const ownTrip = !!(acct && (b.guestAccountId === acct.id || (acct.emailVerifiedAt && String(b.guestEmail || '').toLowerCase() === acct.email)));
    if (!ownTrip && !codeMatches(b, cleanCode(body.code)) && !nameMatches(b, firstName, surname)) return res.status(403).json({ error: 'name_mismatch', message: 'That name doesn’t match the booking. Please use the name the stay was booked under.' });
    if (lockedTo(b, acct)) return res.status(409).json({ error: 'already_done', message: 'This stay’s guestbook is already filled in. Sign in with the account that did it to change it.' });

    // Extras and cleans, and what they cost: only what isn't already on the booking.
    const want = body.extras || {};
    const picked = extrasOf(b).filter((x) => want[x.key]);
    const offer = instayOf(b);
    const paidCleans = new Set(paidCleansOf(b));
    const booked = new Set((await prisma.clean.findMany({ where: { bookingId: b.id }, select: { date: true } })).filter((c) => c.date).map((c) => iso(c.date)));
    const cleans = offer ? [...new Set((Array.isArray(body.cleans) ? body.cleans : []).map(String))]
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= offer.from && d <= offer.to && !booked.has(d)).sort().slice(0, 60) : [];
    const items = [
      ...picked.filter((x) => !haveExtra(b, x.key) && x.cents > 0).map((x) => ({ key: x.key, label: x.label, cents: x.cents })),
      ...(offer && offer.cents ? cleans.filter((d) => !paidCleans.has(d)).map((d) => ({ date: d, label: `Mid-stay clean · ${fmtDay(`${d}T12:00:00Z`)}`, cents: offer.cents })) : []),
    ];
    const charge = items.reduce((n, l) => n + l.cents, 0);
    const chargedCleans = items.filter((l) => l.date).length;
    const payMethod = String(body.payMethod || '');
    if (charge > 0) {
      if (!body.agreeCharges) return res.status(400).json({ error: 'agree_charges', message: 'Please confirm you’re happy to pay for the extras.' });
      if (!payMethodsFor(b).includes(payMethod)) return res.status(400).json({ error: 'pay_method', message: 'Please choose how you’d like to pay.' });
    }

    // The account: the signed-in one, or a new one made from this form.
    let token = null;
    if (!acct) {
      const password = String(body.password || '');
      if (password.length < 8) return res.status(400).json({ error: 'password_too_short', message: 'Please choose a password of at least 8 characters.' });
      if (await prisma.guestAccount.findUnique({ where: { email } })) return res.status(409).json({ error: 'email_taken', message: 'You already have a SimonStays account with this email. Please sign in to continue.' });
      acct = await prisma.guestAccount.create({ data: { email, passwordHash: await bcrypt.hash(password, 10), name: `${firstName} ${surname}`, phone } });
      token = signGuest(acct);
      require('./guestAuth').sendConfirmation(acct).catch(() => {});
    } else if (!acct.name || !acct.phone) {
      acct = await prisma.guestAccount.update({ where: { id: acct.id }, data: { name: acct.name || `${firstName} ${surname}`, phone: acct.phone || phone } });
    }

    // Verified: their own trip already, or the phone matches the booking's
    // (a direct booking's full number, or the last 4 digits Airbnb sent us).
    const hostId = b.hostId || b.unit.property.hostId;
    const lookup = b.resCode ? await prisma.guestLookup.findUnique({ where: { hostId_resCode: { hostId, resCode: b.resCode } }, select: { phoneLast4: true } }) : null;
    const typed = digits(phone);
    const phoneOk = !!((lookup && lookup.phoneLast4 && typed.endsWith(lookup.phoneLast4))
      || (digits(b.guestPhone).length >= 9 && typed.slice(-9) === digits(b.guestPhone).slice(-9)));
    const verified = ownTrip || phoneOk;

    // Extras the guest unticked come off, unless the host added them or they're paid.
    const flag = (key) => haveExtra(b, key) || !!want[key];
    await prisma.booking.update({
      where: { id: b.id },
      data: {
        guestName: `${firstName} ${surname}`,
        guestEmail: b.guestEmail || email,
        guestPhone: phone,
        guestNotes: notes,
        requestedCleans: cleans.length ? cleans : Prisma.DbNull,
        earlyCheckIn: flag('earlyCheckIn'), lateCheckOut: flag('lateCheckOut'), extraMattress: flag('extraMattress'), hairDryer: flag('hairDryer'),
        // A new request replaces an earlier unpaid one; one already paid stays paid.
        ...(charge > 0 ? { extrasCents: charge, extrasItems: items, extrasPayMethod: payMethod, extrasPaidAt: null }
          : !b.extrasPaidAt ? { extrasCents: null, extrasItems: Prisma.DbNull, extrasPayMethod: null } : {}),
        guestbookAt: new Date(),
        guestbookVerified: verified,
        guestbookAccountId: acct.id,
        ...(verified && !b.guestAccountId ? { guestAccountId: acct.id } : {}),
      },
    });

    // The host's contact book: update the guest if they're known, else add them.
    const known = await prisma.guest.findFirst({ where: { hostId, OR: [{ email: { equals: email, mode: 'insensitive' } }, ...(typed.length >= 9 ? [{ phone: { contains: typed.slice(-9) } }] : [])] } });
    if (known) await prisma.guest.update({ where: { id: known.id }, data: { name: `${firstName} ${surname}`, email, phone } });
    else await prisma.guest.create({ data: { hostId, name: `${firstName} ${surname}`, email, phone } });

    // Paying: start the card payment, or hand over the bank details.
    let payment = null, eft = null, payError = null;
    if (charge > 0 && payMethod === 'card') {
      try {
        const c = await payments.createCheckout(b, charge, { base: siteBase(req), kind: 'extras' });
        payment = c.mode === 'form' ? { goUrl: c.goUrl } : null;
        if (!payment) payError = 'Card payment isn’t available right now. Please pay by EFT instead.';
      } catch (e) { console.error('[guestbook] card checkout failed', e.message); payError = 'We couldn’t start the card payment. Please try again, or pay by EFT.'; }
    }
    if (charge > 0 && payMethod === 'eft') eft = await eftFor(hostId);

    // Tell the host, in the booking's conversation and by WhatsApp.
    const airbnb = b.source === 'airbnb';
    const lines = [
      '📒 Guestbook filled in',
      `Name: ${firstName} ${surname}`,
      `Phone: ${phone}`,
      `Email: ${email}`,
      picked.length ? `Extras: ${picked.map((x) => `${x.label}${x.cents ? ` (${fmtR(x.cents)})` : ''}`).join(', ')}` : 'Extras: none',
      cleans.length ? `Mid-stay cleans: ${cleans.map((d) => fmtDay(`${d}T12:00:00Z`)).join(', ')}${offer.cents ? ` (${fmtR(offer.cents)} each)` : ''}` : null,
      charge > 0 ? `To pay: ${fmtR(charge)}, by ${PAY_LABEL[payMethod]}${payMethod === 'eft' ? ` (reference ${payRef(b)})` : ''}.` : null,
      notes ? `Special instructions: ${notes}` : null,
    ].filter(Boolean);
    await prisma.message.create({ data: { hostId, bookingId: b.id, sender: 'guest', authorId: acct.id, authorName: `${firstName} ${surname}`, body: lines.join('\n') } });
    const place = `${b.unit.property.name} · ${b.unit.name}`;
    const todo = { airbnb: 'send a payment request in Airbnb', card: 'paying by card now (you’ll get another alert when it’s through)', eft: `paying by EFT, reference ${payRef(b)}: mark it paid on the booking when it arrives` };
    alertHost(b, [
      `📒 Guestbook: ${firstName} ${surname} (${airbnb ? 'Airbnb' : 'SimonStays'}), ${place}, ${fmtDay(b.checkIn)} → ${fmtDay(shownCheckOut(b))}`,
      charge > 0 ? `💰 ${fmtR(charge)} for extras${chargedCleans ? ` (incl. ${chargedCleans} mid-stay clean${chargedCleans > 1 ? 's' : ''})` : ''}: ${todo[payMethod]}.` : null,
      notes ? `📝 ${notes.slice(0, 300)}` : null,
      verified ? null : '⚠️ Not verified (phone didn’t match Airbnb’s). Link their account from the booking once you’re sure it’s them.',
    ].filter(Boolean).join('\n'));

    res.json({
      ok: true, verified, chargeCents: charge, payMethod: charge > 0 ? payMethod : null, channel: airbnb ? 'airbnb' : 'simonstays',
      payment, payError, eft, reference: charge > 0 ? payRef(b) : null,
      token, account: token ? { id: acct.id, email: acct.email, name: acct.name, phone: acct.phone, emailVerified: false } : undefined,
    });
  } catch (e) { next(e); }
});

// POST /public/guestbook/:id/pay — try the card payment again for extras still
// unpaid (after a cancelled or failed Paygate payment). The amount is the one
// saved with the guestbook, never from the browser.
router.post('/:id/pay', async (req, res, next) => {
  try {
    if (overLimit(`pay:${req.ip}`, 10)) return tooMany(res);
    const b = await prisma.booking.findUnique({ where: { id: String(req.params.id) }, include: BOOKING_INCLUDE });
    if (!b || !(b.extrasCents > 0) || b.extrasPaidAt) return res.status(400).json({ error: 'nothing_owing', message: 'There’s nothing left to pay for these extras.' });
    if (!payments.isOnline()) return res.status(400).json({ error: 'offline', message: 'Card payment isn’t available right now. Please pay by EFT instead.' });
    const c = await payments.createCheckout(b, b.extrasCents, { base: siteBase(req), kind: 'extras' });
    res.json({ payment: c.mode === 'form' ? { goUrl: c.goUrl } : null, amountCents: b.extrasCents });
  } catch (e) { next(e); }
});

module.exports = router;
