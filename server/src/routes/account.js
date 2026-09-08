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

router.get('/', async (req, res) => {
  const h = await prisma.host.findUnique({ where: { id: req.hostId } });
  if (!h) return res.status(404).json({ error: 'not_found' });
  res.json({ account: publicAccount(h) });
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
