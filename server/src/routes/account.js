// Host account: payout details (where SimonStays pays this host out) and
// login-credential management. All host-scoped via authHost — every host only
// ever sees and edits their own account, which is what makes the platform
// multi-tenant: a new login manages its own properties, payouts and credentials.
const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

const PAYOUT = ['payoutMethod', 'payoutBankName', 'payoutAccountName', 'payoutAccountNumber', 'payoutBranchCode', 'payoutNotes'];

function publicAccount(h) {
  const out = { id: h.id, email: h.email, name: h.name, contactPhone: h.contactPhone || null, createdAt: h.createdAt };
  PAYOUT.forEach((k) => { out[k] = h[k] || null; });
  return out;
}

async function hostPhotoId(hostId) {
  const p = await prisma.photo.findFirst({ where: { hostId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  return p ? p.id : null;
}

router.get('/', async (req, res) => {
  const h = await prisma.host.findUnique({ where: { id: req.hostId } });
  if (!h) return res.status(404).json({ error: 'not_found' });
  res.json({ account: { ...publicAccount(h), photoId: await hostPhotoId(h.id) } });
});

// SimonStays takes its service fee (utils/fees, 10%) off each payout.
const { FEE_PERCENT: AGENCY_FEE_PERCENT, feeOf, grossOf } = require('../utils/fees');

// GET /account/payments — bookings SimonStays collected for this host (website
// bookings, paid), each with a priced breakdown and the SimonStays fee
// deduction, so the host sees the net amount paid out to them. The money comes
// from what the booking was actually charged; the quote only itemises it.
router.get('/payments', async (req, res) => {
  const { quote } = require('../utils/pricing');
  const { overridesFor } = require('../utils/nightPrices');
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const bookings = await prisma.booking.findMany({
    where: { hostId: req.hostId, source: 'website', OR: [{ paid: true }, { paymentStatus: 'paid' }] },
    include: { unit: { include: { property: true, pricingGroup: true } }, cleans: true },
    orderBy: { checkIn: 'desc' },
  });
  const payments = [];
  for (const b of bookings) {
    if (!b.unit) continue;
    let q = null;
    const grossCents = grossOf(b);
    const agencyFeeCents = feeOf(grossCents);
    const netPayoutCents = grossCents - agencyFeeCents;
    if (b.unit.pricingGroup) {
      const overrides = await overridesFor(b.unitId, iso(b.checkIn), iso(b.checkOut));
      const prepaid = (b.cleans || []).filter((c) => c.paymentMethod !== 'direct').length;
      q = quote(b.unit.pricingGroup, { checkIn: iso(b.checkIn), checkOut: iso(b.checkOut), mattress: b.extraMattress, earlyCheckIn: b.earlyCheckIn, lateCheckOut: b.lateCheckOut, cleans: 1 + prepaid, overrides });
    }
    payments.push({
      id: b.id, property: b.unit.property.name, unit: b.unit.name, source: b.source, guestName: b.guestName || null,
      checkIn: iso(b.checkIn), checkOut: iso(b.checkOut),
      extras: { earlyCheckIn: !!b.earlyCheckIn, lateCheckOut: !!b.lateCheckOut, extraMattress: !!b.extraMattress },
      quote: q, grossCents, agencyFeeCents, netPayoutCents,
    });
  }
  const totalGrossCents = payments.reduce((s, p) => s + p.grossCents, 0);
  const totalFeeCents = payments.reduce((s, p) => s + p.agencyFeeCents, 0);
  const totalPaidOutCents = payments.reduce((s, p) => s + p.netPayoutCents, 0);
  res.json({ payments, totalGrossCents, totalFeeCents, totalPaidOutCents, agencyFeePercent: AGENCY_FEE_PERCENT });
});

// GET /account/new-bookings?after=ISO — this host's bookings confirmed since
// `after` (at most a day back), for Hosting's "ka-ching": the sound and the card.
// SimonStays bookings come with what the host earns after the fee.
router.get('/new-bookings', async (req, res) => {
  const now = new Date();
  const asked = new Date(String(req.query.after || ''));
  const after = Number.isNaN(asked.getTime()) ? now : new Date(Math.max(asked.getTime(), now.getTime() - 864e5));
  const bookings = await prisma.booking.findMany({
    where: {
      status: 'confirmed', confirmedAt: { gt: after, lte: now },
      OR: [{ hostId: req.hostId }, { unit: { property: { hostId: req.hostId } } }],
    },
    include: { unit: { include: { property: { select: { name: true } } } } },
    orderBy: { confirmedAt: 'asc' }, take: 20,
  });
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  res.json({
    now: now.toISOString(),
    bookings: bookings.map((b) => {
      const simonStays = b.source === 'website';
      const grossCents = simonStays ? grossOf(b) : null;
      return {
        id: b.id, unitId: b.unitId, source: b.source, simonStays, confirmedAt: b.confirmedAt,
        place: [b.unit?.property?.name, b.unit?.name && `Unit ${b.unit.name}`].filter(Boolean).join(' · '),
        guestName: b.guestName || null, checkIn: iso(b.checkIn), checkOut: iso(b.checkOut),
        nights: Math.max(0, Math.round((new Date(b.checkOut) - new Date(b.checkIn)) / 864e5)),
        grossCents, earnCents: simonStays ? grossCents - feeOf(grossCents) : null,
      };
    }),
  });
});

// POST /account/photo { dataBase64, contentType } — set the host's profile photo
// (replaces any existing one). DELETE removes it.
router.post('/photo', async (req, res) => {
  let { dataBase64, contentType } = req.body || {};
  if (!dataBase64) return res.status(400).json({ error: 'no_image' });
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataBase64);
  if (m) { contentType = contentType || m[1]; dataBase64 = m[2]; }
  let buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length < 100) return res.status(400).json({ error: 'no_image' });
  const out = await require('../utils/imagePrep').toRenderable(buffer, contentType || 'image/jpeg');
  await prisma.photo.deleteMany({ where: { hostId: req.hostId } }); // one profile photo
  const photo = await prisma.photo.create({ data: { hostId: req.hostId, data: out.buffer, contentType: out.contentType, filename: 'profile' }, select: { id: true } });
  res.status(201).json({ photoId: photo.id });
});

router.delete('/photo', async (req, res) => {
  await prisma.photo.deleteMany({ where: { hostId: req.hostId } });
  res.json({ ok: true });
});

// PUT /account/profile — name + payout details
router.put('/profile', async (req, res) => {
  const b = req.body || {};
  const data = {};
  if ('name' in b) data.name = b.name || null;
  if ('contactPhone' in b) data.contactPhone = b.contactPhone || null;
  PAYOUT.forEach((k) => { if (k in b) data[k] = b[k] || null; });
  const h = await prisma.host.update({ where: { id: req.hostId }, data });
  res.json({ account: publicAccount(h) });
});

// PUT /account/password — { currentPassword, newPassword }
router.put('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'both_passwords_required' });
  if (String(newPassword).length < 8) return res.status(400).json({ error: 'password_too_short', message: 'New password must be at least 8 characters.' });
  const h = await prisma.host.findUnique({ where: { id: req.hostId } });
  const ok = await bcrypt.compare(currentPassword, h.passwordHash);
  if (!ok) return res.status(401).json({ error: 'wrong_password', message: 'Your current password is incorrect.' });
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.host.update({ where: { id: h.id }, data: { passwordHash } });
  res.json({ ok: true });
});

// PUT /account/email — { currentPassword, newEmail }
router.put('/email', async (req, res) => {
  const { currentPassword, newEmail } = req.body || {};
  if (!currentPassword || !newEmail) return res.status(400).json({ error: 'password_and_email_required' });
  const email = String(newEmail).toLowerCase().trim();
  if (!/.+@.+\..+/.test(email)) return res.status(400).json({ error: 'invalid_email', message: 'Please enter a valid email.' });
  const h = await prisma.host.findUnique({ where: { id: req.hostId } });
  const ok = await bcrypt.compare(currentPassword, h.passwordHash);
  if (!ok) return res.status(401).json({ error: 'wrong_password', message: 'Your password is incorrect.' });
  const taken = await prisma.host.findUnique({ where: { email } });
  if (taken && taken.id !== h.id) return res.status(409).json({ error: 'email_taken', message: 'That email is already in use.' });
  const updated = await prisma.host.update({ where: { id: h.id }, data: { email } });
  res.json({ account: publicAccount(updated) });
});

module.exports = router;
