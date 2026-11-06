// Public guest accounts for the SimonStays shopfront. A guest signs up with an
// email + password so they can see their upcoming and previous trips. This is
// deliberately separate from host auth (/auth) and from the host-scoped Guest
// contact book — it is the customer's own login. No host token is ever accepted
// here. (Future: guest <-> host messaging + self-service booking changes.)

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { shownCheckOut, shownNights } = require('../utils/ical');
const { signGuest, sign } = require('../lib/jwt');
const { authGuest } = require('../middleware/auth');
const { DEFAULT_CANCELLATION_POLICY } = require('../utils/policy');
const payments = require('../utils/payments');
const mailer = require('../utils/mailer');
const { onTrip, isBooker } = require('../utils/guestAccess');
const { readDocument } = require('../utils/guestDocuments');
const { owesBalance } = require('../utils/messaging');

const router = express.Router();

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const publicAcct = (a) => ({ id: a.id, email: a.email, name: a.name || null, phone: a.phone || null, createdAt: a.createdAt, emailVerified: !!a.emailVerifiedAt });

// POST /public/account/register { email, password, name, phone, profilePhoto, idDocument }
// (the two files are each { filename, data } with data in base64)
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, phone, profilePhoto, idDocument } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
    if (String(password).length < 8) return res.status(400).json({ error: 'password_too_short', message: 'Please use at least 8 characters.' });
    const norm = String(email).trim().toLowerCase();
    const existing = await prisma.guestAccount.findUnique({ where: { email: norm } });
    if (existing) return res.status(409).json({ error: 'email_taken', message: 'An account with that email already exists — please sign in.' });
    const photo = readDocument('photo', profilePhoto);
    if (photo.error) return res.status(400).json({ error: 'profile_photo_required', message: photo.error });
    const id = readDocument('id', idDocument);
    if (id.error) return res.status(400).json({ error: 'id_document_required', message: id.error });
    const passwordHash = await bcrypt.hash(password, 10);
    const acct = await prisma.guestAccount.create({
      data: { email: norm, passwordHash, name: (name || '').trim() || null, phone: (phone || '').trim() || null, documents: { create: [photo, id] } },
    });
    sendConfirmation(acct).catch(() => {});
    res.status(201).json({ token: signGuest(acct), account: publicAcct(acct) });
  } catch (e) { next(e); }
});

// POST /public/account/login { email, password }
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
    const norm = String(email).trim().toLowerCase();
    let acct = await prisma.guestAccount.findUnique({ where: { email: norm } });
    // One account: a host signing in to travel for the first time gets a guest
    // side made from their hosting login. It starts unconfirmed, so trips booked
    // under that email stay hidden until the emailed link is clicked.
    if (!acct) {
      const host = await prisma.host.findUnique({ where: { email: norm } });
      if (host && await bcrypt.compare(password, host.passwordHash)) {
        acct = await prisma.guestAccount.create({ data: { email: norm, passwordHash: host.passwordHash, name: host.name || null, phone: host.contactPhone || null } });
        sendConfirmation(acct).catch(() => {});
        return res.json({ token: signGuest(acct), account: publicAcct(acct), hostToken: sign(host) });
      }
    }
    if (!acct) return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect email or password.' });
    const ok = await bcrypt.compare(password, acct.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect email or password.' });
    // Accounts from before emails were confirmed get their link when they next sign in.
    if (!acct.emailVerifiedAt && !sentWithin(acct, VERIFY_LOGIN_RESEND_MS)) sendConfirmation(acct).catch(() => {});
    // Same password on the hosting side too → hand back that session as well, so
    // "Switch to hosting" needs no second sign-in.
    const host = await prisma.host.findUnique({ where: { email: norm } });
    const hostToken = host && await bcrypt.compare(password, host.passwordHash) ? sign(host) : undefined;
    res.json({ token: signGuest(acct), account: publicAcct(acct), hostToken });
  } catch (e) { next(e); }
});

// POST /public/account/become-host — "Switch to hosting" for a guest with no
// hosting account yet: open one with the same email, name and password. Only
// for a confirmed email, so nobody can claim a hosting account for an address
// they don't own.
router.post('/become-host', authGuest, async (req, res, next) => {
  try {
    const acct = await prisma.guestAccount.findUnique({ where: { id: req.guestId } });
    if (!acct) return res.status(404).json({ error: 'not_found' });
    const existing = await prisma.host.findUnique({ where: { email: acct.email } });
    if (existing) return res.status(409).json({ error: 'host_exists', message: 'You already have a hosting account. Sign in with your hosting password.' });
    if (!acct.emailVerifiedAt) return res.status(403).json({ error: 'email_unverified', message: 'Please confirm your email first. We’ve sent you a link.' });
    const host = await prisma.host.create({ data: { email: acct.email, passwordHash: acct.passwordHash, name: acct.name || null, contactPhone: acct.phone || null } });
    res.status(201).json({ token: sign(host), host: { id: host.id, email: host.email, name: host.name } });
  } catch (e) { next(e); }
});

const VERIFY_MS = 7 * 864e5; // a confirmation link works for a week
const VERIFY_RESEND_MS = 60 * 1000; // at most one email a minute per account
const VERIFY_LOGIN_RESEND_MS = 10 * 60 * 1000;
const sentWithin = (acct, ms) => !!acct.verifySentAt && Date.now() - acct.verifySentAt.getTime() < ms;

// Email a link that proves this address is theirs.
async function sendConfirmation(acct) {
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.guestAccount.update({ where: { id: acct.id }, data: { verifyTokenHash: hashToken(token), verifySentAt: new Date() } });
  const base = (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
  const link = `${base}/?verify=${encodeURIComponent(token)}`;
  return mailer.sendMail({
    to: acct.email,
    subject: 'Confirm your email for SimonStays',
    text: `Please confirm your email so you can see your SimonStays trips and messages. This link works for a week:\n\n${link}\n\nIf you didn't sign up, you can ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#1d2433">` +
      `<p>Please confirm your email so you can see your SimonStays trips and messages. This link works for a week.</p>` +
      `<p><a href="${link}" style="display:inline-block;background:#1a7a3a;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Confirm my email</a></p>` +
      `<p style="color:#6b7280;font-size:13px">If you didn't sign up, you can ignore this email.</p></div>`,
  });
}

// The address is proved: mark it, and link bookings made with it to this account.
async function markVerified(acctId, email, extra = {}) {
  const updated = await prisma.guestAccount.update({ where: { id: acctId }, data: { emailVerifiedAt: new Date(), verifyTokenHash: null, verifySentAt: null, ...extra } });
  await prisma.booking.updateMany({ where: { guestAccountId: null, guestEmail: { equals: email, mode: 'insensitive' } }, data: { guestAccountId: acctId } });
  return updated;
}

// POST /public/account/verify-email { token } — from the emailed link. Doesn't sign
// in: the link only proves the address, and could be opened on any device.
router.post('/verify-email', async (req, res, next) => {
  try {
    const token = (req.body || {}).token;
    const acct = token ? await prisma.guestAccount.findFirst({ where: { verifyTokenHash: hashToken(token), verifySentAt: { gt: new Date(Date.now() - VERIFY_MS) } } }) : null;
    if (!acct) return res.status(400).json({ error: 'verify_link_invalid', message: 'This link has expired or was already used. Sign in and we’ll send you a new one.' });
    await markVerified(acct.id, acct.email);
    res.json({ ok: true, email: acct.email });
  } catch (e) { next(e); }
});

// POST /public/account/verify-email/resend — send the signed-in guest a new link.
router.post('/verify-email/resend', authGuest, async (req, res, next) => {
  try {
    const acct = await prisma.guestAccount.findUnique({ where: { id: req.guestId } });
    if (!acct) return res.status(404).json({ error: 'not_found' });
    if (acct.emailVerifiedAt) return res.json({ ok: true, alreadyVerified: true });
    if (sentWithin(acct, VERIFY_RESEND_MS)) return res.status(429).json({ error: 'too_soon', message: 'We’ve just sent one. Please check your inbox, or try again in a minute.' });
    const sent = await sendConfirmation(acct);
    res.json({ ok: !!sent });
  } catch (e) { next(e); }
});

const RESET_MS = 60 * 60 * 1000; // a reset link works for an hour
const RESET_RESEND_MS = 60 * 1000; // at most one email a minute per account
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function emailResetLink(acct, token) {
  const base = (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
  const link = `${base}/?reset=${encodeURIComponent(token)}`;
  return mailer.sendMail({
    to: acct.email,
    subject: 'Reset your SimonStays password',
    text: `Use this link to choose a new SimonStays password. It works for one hour:\n\n${link}\n\nIf you didn't ask for this, you can ignore this email and your password stays the same.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#1d2433">` +
      `<p>Use this button to choose a new SimonStays password. It works for one hour.</p>` +
      `<p><a href="${link}" style="display:inline-block;background:#1a7a3a;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Choose a new password</a></p>` +
      `<p style="color:#6b7280;font-size:13px">If you didn't ask for this, you can ignore this email and your password stays the same.</p></div>`,
  });
}

// POST /public/account/forgot-password { email } — answers the same whether or not
// the account exists, and doesn't wait for the email, so it can't reveal who has one.
router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email_required', message: 'Please enter your email.' });
    const acct = await prisma.guestAccount.findUnique({ where: { email } });
    const justSent = acct && acct.resetExpiresAt && acct.resetExpiresAt.getTime() - Date.now() > RESET_MS - RESET_RESEND_MS;
    if (acct && !justSent) {
      const token = crypto.randomBytes(32).toString('base64url');
      await prisma.guestAccount.update({ where: { id: acct.id }, data: { resetTokenHash: hashToken(token), resetExpiresAt: new Date(Date.now() + RESET_MS) } });
      emailResetLink(acct, token).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /public/account/reset-password { token, password } — sets it and signs in.
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (String(password || '').length < 8) return res.status(400).json({ error: 'password_too_short', message: 'Please use at least 8 characters.' });
    const acct = token ? await prisma.guestAccount.findFirst({ where: { resetTokenHash: hashToken(token), resetExpiresAt: { gt: new Date() } } }) : null;
    if (!acct) return res.status(400).json({ error: 'reset_link_invalid', message: 'This link has expired or was already used. Please ask for a new one.' });
    // The reset link came to their inbox, so this proves the address too.
    const updated = await markVerified(acct.id, acct.email, { passwordHash: await bcrypt.hash(password, 10), resetTokenHash: null, resetExpiresAt: null });
    res.json({ token: signGuest(updated), account: publicAcct(updated) });
  } catch (e) { next(e); }
});

// POST /public/account/change-password { currentPassword, newPassword }
router.post('/change-password', authGuest, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (String(newPassword || '').length < 8) return res.status(400).json({ error: 'password_too_short', message: 'Please use at least 8 characters.' });
    const acct = await prisma.guestAccount.findUnique({ where: { id: req.guestId } });
    if (!acct) return res.status(404).json({ error: 'not_found' });
    if (!(await bcrypt.compare(String(currentPassword || ''), acct.passwordHash))) return res.status(400).json({ error: 'wrong_password', message: 'Your current password is incorrect.' });
    await prisma.guestAccount.update({
      where: { id: acct.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), resetTokenHash: null, resetExpiresAt: null },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /public/account/me
// GET /public/account/instant — the guest's rating from hosts, and whether it
// opens instant booking on listings set to "5-star guests".
router.get('/instant', authGuest, async (req, res, next) => {
  try {
    const bm = require('../utils/bookingMode');
    const rating = await bm.ratingForAccount(req.guestId);
    res.json({ fiveStar: bm.isFiveStar(rating), rating: rating ? { average: rating.average, count: rating.count } : null });
  } catch (e) { next(e); }
});

router.get('/me', authGuest, async (req, res, next) => {
  try {
    const acct = await prisma.guestAccount.findUnique({ where: { id: req.guestId } });
    if (!acct) return res.status(404).json({ error: 'not_found' });
    res.json({ account: publicAcct(acct) });
  } catch (e) { next(e); }
});

// PATCH /public/account/me { name, phone } — edit profile.
router.patch('/me', authGuest, async (req, res, next) => {
  try {
    const { name, phone } = req.body || {};
    const acct = await prisma.guestAccount.update({
      where: { id: req.guestId },
      data: { name: name != null ? (String(name).trim() || null) : undefined, phone: phone != null ? (String(phone).trim() || null) : undefined },
    });
    res.json({ account: publicAcct(acct) });
  } catch (e) { next(e); }
});

// Turn a booking (with unit + property) into a guest-facing trip object.
function tripOf(b, acct) {
  const shared = !isBooker(b, acct);
  const u = b.unit || null;
  const p = (u && u.property) || null;
  const nights = shownNights(b);
  const confirmed = b.status === 'confirmed';
  const arrivalHeld = confirmed && owesBalance(b);
  return {
    id: b.id,
    ref: b.ref || null,
    status: b.status, // 'confirmed' | 'pending' | 'cancelled'
    shared, // on this trip as the booker's friend: no prices, no paying or cancelling
    paymentStatus: b.paymentStatus || null,
    propertyName: p ? p.name : null,
    unitName: u ? u.name : null,
    unitId: u ? u.id : null, // for "Report damage" on the trip
    hostId: p ? p.hostId : null,
    address: p ? (p.address || null) : null,
    checkIn: iso(b.checkIn),
    checkOut: iso(shownCheckOut(b)),
    dayUse: !!b.dayUse,
    checkInTime: (u && u.checkInTime) || (p && p.checkInTime) || '15:00',
    checkOutTime: (u && u.checkOutTime) || (p && p.checkOutTime) || '10:00',
    nights,
    guestName: b.guestName || null,
    totalCents: !shared && b.totalCents != null ? b.totalCents : null,
    depositCents: !shared && b.depositCents != null ? b.depositCents : null,
    amountOwingCents: !shared && b.amountOwingCents != null ? b.amountOwingCents : null,
    // A website booking with a balance left can be paid online from "My trips".
    canPayBalance: !shared && confirmed && b.source === 'website' && b.amountOwingCents > 0 && payments.isOnline(),
    cancellationPolicy: (p && p.cancellationPolicy) || DEFAULT_CANCELLATION_POLICY,
    coverPhotoId: (u && u.photos && u.photos[0] && u.photos[0].id) || (p && p.photos && p.photos[0] && p.photos[0].id) || null,
    // Practical arrival info the guest is entitled to — only once confirmed and fully paid.
    arrivalHeld,
    wifiName: confirmed && !arrivalHeld && u ? (u.wifiName || null) : null,
    accessCode: confirmed && !arrivalHeld ? (b.accessCode || null) : null,
    parking: arrivalHeld ? null : (u && u.parkingNotes) || null,
  };
}

// GET /public/account/trips — the signed-in guest's bookings, split into
// upcoming and previous. Matches by explicit account link OR by email, so
// bookings made before signing up (or without signing in) still show up.
router.get('/trips', authGuest, async (req, res, next) => {
  try {
    const acct = await prisma.guestAccount.findUnique({ where: { id: req.guestId } });
    if (!acct) return res.status(404).json({ error: 'not_found' });
    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: ['confirmed', 'pending', 'cancelled'] },
        ...onTrip(acct),
      },
      include: {
        unit: {
          include: {
            property: { include: { photos: { orderBy: { sort: 'asc' }, take: 1, select: { id: true } } } },
            photos: { orderBy: { sort: 'asc' }, take: 1, select: { id: true } },
          },
        },
      },
      orderBy: { checkIn: 'desc' },
    });

    const today = iso(new Date());
    const upcoming = [], previous = [];
    for (const b of bookings) {
      const t = tripOf(b, acct);
      // Upcoming = not cancelled and the stay hasn't ended yet.
      if (b.status !== 'cancelled' && iso(b.checkOut) >= today) upcoming.push(t);
      else previous.push(t);
    }
    // Upcoming: soonest first. Previous already newest-first from the query.
    upcoming.sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1));
    res.json({ upcoming, previous });
  } catch (e) { next(e); }
});

// GET /public/account/trips/:bookingId/invoice — the paper invoice for this trip.
// Only the booker sees it: friends invited to a trip never see prices.
router.get('/trips/:bookingId/invoice', authGuest, async (req, res, next) => {
  try {
    const acct = await prisma.guestAccount.findUnique({ where: { id: req.guestId } });
    if (!acct) return res.status(404).json({ error: 'not_found' });
    const { guestInvoice } = require('../utils/paymentInvoice');
    const r = await guestInvoice(req.params.bookingId);
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    if (!isBooker(r.booking, acct)) return res.status(404).json({ error: 'not_found', message: 'Booking not found.' });
    if (!['confirmed', 'cancelled'].includes(r.booking.status)) return res.status(404).json({ error: 'no_invoice', message: 'Your invoice appears here once your booking is paid.' });
    res.json({ html: r.html, ref: r.booking.ref || null });
  } catch (e) { next(e); }
});

module.exports = router;

// Used by /auth/guest-session when it opens a travelling side for a host.
router.sendConfirmation = sendConfirmation;
