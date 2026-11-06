const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { sign, signGuest } = require('../lib/jwt');
const { authHost, isAdminEmail } = require('../middleware/auth');

const router = express.Router();

// POST /auth/register { email, password, name }
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'password_too_short' });

  const existing = await prisma.host.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(409).json({ error: 'email_taken' });

  const passwordHash = await bcrypt.hash(password, 10);
  const host = await prisma.host.create({
    data: { email: email.toLowerCase(), passwordHash, name: name || null },
  });
  res.status(201).json({ token: sign(host), host: publicHost(host) });
});

// POST /auth/login { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
  const host = await prisma.host.findUnique({ where: { email: String(email).toLowerCase() } });
  if (!host) return res.status(401).json({ error: 'invalid_credentials' });
  const ok = await bcrypt.compare(password, host.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
  res.json({ token: sign(host), host: publicHost(host) });
});

// GET /auth/me
router.get('/me', authHost, async (req, res) => {
  const host = await prisma.host.findUnique({ where: { id: req.hostId } });
  if (!host) return res.status(404).json({ error: 'not_found' });
  res.json({ host: publicHost(host) });
});

// POST /auth/guest-session — "Switch to travelling". One account: the host's
// travelling side shares their email and password. Made fresh (unconfirmed, so
// trips stay hidden until the emailed link is clicked) when there isn't one.
// An existing guest account is only reused if it was made this way (same
// password hash); otherwise the person signs in on the travelling side, so a
// hosting account can never take over someone else's trips.
router.post('/guest-session', authHost, async (req, res, next) => {
  try {
    const host = await prisma.host.findUnique({ where: { id: req.hostId } });
    if (!host) return res.status(404).json({ error: 'not_found' });
    let acct = await prisma.guestAccount.findUnique({ where: { email: host.email } });
    if (acct && acct.passwordHash !== host.passwordHash) return res.status(409).json({ error: 'sign_in_needed' });
    if (!acct) {
      acct = await prisma.guestAccount.create({ data: { email: host.email, passwordHash: host.passwordHash, name: host.name || null, phone: host.contactPhone || null } });
      require('./guestAuth').sendConfirmation(acct).catch(() => {});
    }
    res.json({ token: signGuest(acct), account: { id: acct.id, email: acct.email, name: acct.name || null, phone: acct.phone || null, createdAt: acct.createdAt, emailVerified: !!acct.emailVerifiedAt } });
  } catch (e) { next(e); }
});

function publicHost(h) { return { id: h.id, email: h.email, name: h.name, createdAt: h.createdAt, isAdmin: isAdminEmail(h.email) }; }

module.exports = router;
