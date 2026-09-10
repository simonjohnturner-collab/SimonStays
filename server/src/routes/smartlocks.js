// Smart-lock dashboard: the host's smart-lock units, their battery + codes for
// current/upcoming stays, plus the RemoteLock provider connection so live device
// data (battery, online status, access codes) can be pulled in automatically.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const { verify } = require('../lib/jwt');
const RL = require('../utils/remotelock');

const router = express.Router();

const ADMIN_URL = (process.env.ADMIN_URL || 'https://simonstays.onrender.com').replace(/\/$/, '');

// ---- PUBLIC: OAuth callback (browser redirect back from RemoteLock) ----
// Defined BEFORE authHost so it runs without a Bearer token; the host identity
// is carried in the signed `state` we set when starting the flow.
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const back = (ok, note) => res.redirect(`${ADMIN_URL}/?smartlock=${ok ? 'connected' : 'error'}${note ? `&msg=${encodeURIComponent(note)}` : ''}`);
  if (error) return back(false, String(error));
  let hostId;
  try { hostId = verify(String(state)).hostId; } catch { return back(false, 'expired_link'); }
  try {
    const provider = await prisma.lockProvider.findUnique({ where: { hostId } });
    if (!provider || !provider.clientId) return back(false, 'no_credentials');
    const tok = await RL.exchangeCode({
      clientId: provider.clientId, clientSecret: provider.clientSecret,
      code: String(code), redirect: RL.redirectUri(req),
    });
    await RL.storeTokens(provider.id, tok);
    return back(true);
  } catch (e) {
    await prisma.lockProvider.updateMany({ where: { hostId }, data: { lastError: e.message } }).catch(() => {});
    return back(false, e.message);
  }
});

// Everything below requires an authenticated host.
router.use(authHost);

// ---- Dashboard data ----
router.get('/', async (req, res) => {
  const now = new Date();
  const [units, provider] = await Promise.all([
    prisma.unit.findMany({
      where: { accessMethod: 'Smart lock', property: { hostId: req.hostId } },
      include: { property: { select: { name: true, sortOrder: true } } },
      orderBy: [{ property: { sortOrder: 'asc' } }, { name: 'asc' }],
    }),
    prisma.lockProvider.findUnique({ where: { hostId: req.hostId } }),
  ]);
  const unitIds = units.map((u) => u.id);
  const bookings = unitIds.length ? await prisma.booking.findMany({
    where: { unitId: { in: unitIds }, status: 'confirmed', checkOut: { gt: now } },
    orderBy: { checkIn: 'asc' },
    select: { id: true, unitId: true, guestName: true, checkIn: true, checkOut: true, accessCode: true, source: true },
  }) : [];
  const byUnit = {};
  bookings.forEach((b) => {
    if (b.guestName === 'Blocked') return;
    (byUnit[b.unitId] = byUnit[b.unitId] || []).push(b);
  });
  res.json({
    provider: provider
      ? { connected: !!provider.accessToken, vendor: provider.vendor, hasCredentials: !!provider.clientId, lastSyncAt: provider.lastSyncAt, lastError: provider.lastError }
      : { connected: false, vendor: 'remotelock', hasCredentials: false, lastSyncAt: null, lastError: null },
    units: units.map((u) => ({
      id: u.id, name: u.name, propertyName: u.property.name,
      lockBattery: u.lockBattery, smartLockUrl: u.smartLockUrl,
      lockDeviceId: u.lockDeviceId, lockDeviceName: u.lockDeviceName,
      lockData: u.lockData, lockSyncedAt: u.lockSyncedAt,
      bookings: byUnit[u.id] || [],
    })),
  });
});

// ---- Provider credentials ----
// Save the RemoteLock OAuth app credentials (Client ID + Secret).
router.post('/provider', async (req, res) => {
  const clientId = (req.body?.clientId || '').trim();
  const clientSecret = (req.body?.clientSecret || '').trim();
  if (!clientId) return res.status(400).json({ error: 'clientId_required' });
  const data = { vendor: 'remotelock', clientId, lastError: null };
  if (clientSecret) data.clientSecret = clientSecret;
  const provider = await prisma.lockProvider.upsert({
    where: { hostId: req.hostId },
    update: data,
    create: { hostId: req.hostId, ...data },
  });
  res.json({ ok: true, hasCredentials: !!provider.clientId, connected: !!provider.accessToken });
});

// Disconnect: clear tokens (and optionally credentials).
router.delete('/provider', async (req, res) => {
  await prisma.lockProvider.updateMany({
    where: { hostId: req.hostId },
    data: { accessToken: null, refreshToken: null, tokenExpiry: null, connectedAt: null, lastError: null },
  });
  res.json({ ok: true });
});

// Connect via the client-credentials grant: save credentials (if supplied),
// mint an access token straight away, and confirm it works — no browser
// redirect needed. Body may include { clientId, clientSecret }.
router.post('/connect', async (req, res) => {
  const clientId = (req.body?.clientId || '').trim();
  const clientSecret = (req.body?.clientSecret || '').trim();
  let provider = await prisma.lockProvider.findUnique({ where: { hostId: req.hostId } });
  if (clientId || !provider) {
    const data = { vendor: 'remotelock', lastError: null };
    if (clientId) data.clientId = clientId;
    if (clientSecret) data.clientSecret = clientSecret;
    provider = await prisma.lockProvider.upsert({
      where: { hostId: req.hostId },
      update: data,
      create: { hostId: req.hostId, clientId, clientSecret, vendor: 'remotelock' },
    });
  }
  if (!provider.clientId || !provider.clientSecret) return res.status(400).json({ error: 'need_id_and_secret', message: 'Enter both the RemoteLock Application ID and Secret.' });
  try {
    const tok = await RL.clientCredentialsToken({ clientId: provider.clientId, clientSecret: provider.clientSecret });
    await RL.storeTokens(provider.id, tok);
    res.json({ ok: true, connected: true });
  } catch (e) {
    await prisma.lockProvider.update({ where: { id: provider.id }, data: { lastError: e.message } }).catch(() => {});
    res.status(502).json({ error: 'connect_failed', message: e.message });
  }
});

// ---- Live devices ----
router.get('/devices', async (req, res) => {
  try {
    const provider = await prisma.lockProvider.findUnique({ where: { hostId: req.hostId } });
    const token = await RL.validAccessToken(provider);
    const raw = await RL.listDevices(token);
    res.json({ devices: raw.map(RL.normaliseDevice) });
  } catch (e) {
    res.status(e.message === 'not_connected' ? 400 : 502).json({ error: 'devices_failed', message: e.message });
  }
});

// Link a RemoteLock device to a unit (or clear with deviceId null).
router.post('/units/:unitId/link', async (req, res) => {
  const unit = await prisma.unit.findUnique({ where: { id: req.params.unitId }, include: { property: true } });
  if (!unit || unit.property.hostId !== req.hostId) return res.status(403).json({ error: 'forbidden' });
  const { deviceId, deviceName } = req.body || {};
  await prisma.unit.update({
    where: { id: unit.id },
    data: { lockDeviceId: deviceId || null, lockDeviceName: deviceId ? (deviceName || null) : null },
  });
  res.json({ ok: true });
});

// Pull live data for every linked unit and cache it (battery + full attributes).
router.post('/sync', async (req, res) => {
  try {
    const provider = await prisma.lockProvider.findUnique({ where: { hostId: req.hostId } });
    const token = await RL.validAccessToken(provider);
    const devices = await RL.listDevices(token);
    const byId = {}; devices.map(RL.normaliseDevice).forEach((d) => { byId[d.id] = d; });
    const units = await prisma.unit.findMany({ where: { property: { hostId: req.hostId }, lockDeviceId: { not: null } } });
    let updated = 0;
    for (const u of units) {
      const d = byId[u.lockDeviceId];
      if (!d) continue;
      await prisma.unit.update({
        where: { id: u.id },
        data: {
          lockData: d.raw, lockSyncedAt: new Date(),
          lockBattery: d.battery != null ? d.battery : u.lockBattery,
          lockDeviceName: d.name || u.lockDeviceName,
        },
      });
      updated += 1;
    }
    await prisma.lockProvider.update({ where: { id: provider.id }, data: { lastSyncAt: new Date(), lastError: null } });
    res.json({ ok: true, updated, devices: devices.length });
  } catch (e) {
    res.status(e.message === 'not_connected' ? 400 : 502).json({ error: 'sync_failed', message: e.message });
  }
});

module.exports = router;
