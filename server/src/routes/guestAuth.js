// Public guest accounts for the SimonStays shopfront. A guest signs up with an
// email + password so they can see their upcoming and previous trips. This is
// deliberately separate from host auth (/auth) and from the host-scoped Guest
// contact book — it is the customer's own login. No host token is ever accepted
// here. (Future: guest <-> host messaging + self-service booking changes.)

const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { signGuest } = require('../lib/jwt');
const { authGuest } = require('../middleware/auth');
const { DEFAULT_CANCELLATION_POLICY } = require('../utils/policy');

const router = express.Router();

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const publicAcct = (a) => ({ id: a.id, email: a.email, name: a.name || null, phone: a.phone || null, createdAt: a.createdAt });

// POST /public/account/register { email, password, name, phone }
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, phone } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
    if (String(password).length < 8) return res.status(400).json({ error: 'password_too_short', message: 'Please use at least 8 characters.' });
    const norm = String(email).trim().toLowerCase();
    const existing = await prisma.guestAccount.findUnique({ where: { email: norm } });
    if (existing) return res.status(409).json({ error: 'email_taken', message: 'An account with that email already exists — please sign in.' });
    const passwordHash = await bcrypt.hash(password, 10);
    const acct = await prisma.guestAccount.create({
      data: { email: norm, passwordHash, name: (name || '').trim() || null, phone: (phone || '').trim() || null },
    });
    // Link any existing bookings made with this email to the new account.
    await prisma.booking.updateMany({
      where: { guestAccountId: null, guestEmail: { equals: norm, mode: 'insensitive' } },
      data: { guestAccountId: acct.id },
    });
    res.status(201).json({ token: signGuest(acct), account: publicAcct(acct) });
  } catch (e) { next(e); }
});

// POST /public/account/login { email, password }
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
    const acct = await prisma.guestAccount.findUnique({ where: { email: String(email).trim().toLowerCase() } });
    if (!acct) return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect email or password.' });
    const ok = await bcrypt.compare(password, acct.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect email or password.' });
    res.json({ token: signGuest(acct), account: publicAcct(acct) });
  } catch (e) { next(e); }
});

// GET /public/account/me
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
function tripOf(b) {
  const u = b.unit || null;
  const p = (u && u.property) || null;
  const nights = Math.max(0, Math.round((new Date(b.checkOut) - new Date(b.checkIn)) / 864e5));
  const confirmed = b.status === 'confirmed';
  return {
    id: b.id,
    ref: b.ref || null,
    status: b.status, // 'confirmed' | 'pending' | 'cancelled'
    paymentStatus: b.paymentStatus || null,
    propertyName: p ? p.name : null,
    unitName: u ? u.name : null,
    address: p ? (p.address || null) : null,
    checkIn: iso(b.checkIn),
    checkOut: iso(b.checkOut),
    checkInTime: (u && u.checkInTime) || (p && p.checkInTime) || '15:00',
    checkOutTime: (u && u.checkOutTime) || (p && p.checkOutTime) || '10:00',
    nights,
    guestName: b.guestName || null,
    totalCents: b.totalCents != null ? b.totalCents : null,
    depositCents: b.depositCents != null ? b.depositCents : null,
    amountOwingCents: b.amountOwingCents != null ? b.amountOwingCents : null,
    cancellationPolicy: (p && p.cancellationPolicy) || DEFAULT_CANCELLATION_POLICY,
    coverPhotoId: (u && u.photos && u.photos[0] && u.photos[0].id) || (p && p.photos && p.photos[0] && p.photos[0].id) || null,
    // Practical arrival info the guest is entitled to — only once confirmed.
    wifiName: confirmed && u ? (u.wifiName || null) : null,
    accessCode: confirmed ? (b.accessCode || null) : null,
    parking: (u && u.parkingNotes) || null,
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
        OR: [
          { guestAccountId: acct.id },
          { guestEmail: { equals: acct.email, mode: 'insensitive' } },
        ],
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
      const t = tripOf(b);
      // Upcoming = not cancelled and the stay hasn't ended yet.
      if (b.status !== 'cancelled' && iso(b.checkOut) >= today) upcoming.push(t);
      else previous.push(t);
    }
    // Upcoming: soonest first. Previous already newest-first from the query.
    upcoming.sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1));
    res.json({ upcoming, previous });
  } catch (e) { next(e); }
});

module.exports = router;
