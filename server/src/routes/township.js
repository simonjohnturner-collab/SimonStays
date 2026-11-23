// Township Stays — the host's plan, credit, payments and leads (/host-township), the
// public listing site's API (/public/township) and Simon's controls (/admin/township).
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, authGuest, requireAdmin } = require('../middleware/auth');
const ts = require('../utils/township');
const paygate = require('../utils/paygate');

const baseOf = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const cents = (v) => (v === '' || v == null ? null : Math.max(0, Math.round(Number(v))));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  if (e.status) return res.status(e.status).json({ error: 'township', message: e.message });
  next(e);
});

// A lead as the host sees it: a locked one keeps the tenant's details hidden.
function leadOut(l) {
  const open = l.status === 'open';
  return {
    id: l.id, propertyId: l.propertyId, propertyName: l.property ? l.property.name : null, status: l.status,
    createdAt: l.createdAt, feeCents: l.feeCents,
    name: open ? l.name : null, phone: open ? l.phone : null, email: open ? l.email : null, message: open ? l.message : null,
  };
}

// ================= host =================
const host = express.Router();
host.use(authHost);

// GET /host-township — everything the host's Township Stays screen shows.
host.get('/', wrap(async (req, res) => {
  const now = new Date();
  const [h, settings] = await Promise.all([prisma.host.findUnique({ where: { id: req.hostId } }), ts.getSettings()]);
  const props = await prisma.property.findMany({
    where: { hostId: req.hostId, kind: 'township' }, orderBy: { createdAt: 'asc' },
    include: { _count: { select: { photos: true, townshipLeads: true } } },
  });
  const [leads, payments, spent] = await Promise.all([
    prisma.townshipLead.findMany({ where: { hostId: req.hostId }, orderBy: { createdAt: 'desc' }, take: 300, include: { property: { select: { name: true } } } }),
    prisma.townshipPayment.findMany({ where: { hostId: req.hostId }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ts.spentThisMonth(req.hostId, now),
  ]);
  const minClick = props.length ? Math.min(...props.map((p) => ts.feesFor(p, settings).clickFeeCents)) : settings.clickFeeCents;
  const shown = props.filter((p) => !p.tsHidden);
  res.json({
    plan: h.tsPlan, creditCents: h.tsCreditCents, spentThisMonthCents: spent,
    activated: !!h.tsActivatedAt,
    // Contact button: click plan = enough credit; monthly = any listing within its paid months.
    clicksOpen: h.tsPlan === 'monthly' ? shown.some((p) => ts.planActive(p, h, now)) : await ts.clicksOpen(h, minClick, now),
    fees: settings,
    listings: props.map((p) => {
      const f = ts.feesFor(p, settings);
      return {
        id: p.id, name: p.name, areaName: p.areaName, hidden: p.tsHidden, paidUntil: p.tsPaidUntil,
        paid: ts.planActive(p, h, now), availableFrom: p.availableFrom,
        monthlyFeeCents: f.monthlyFeeCents, clickFeeCents: f.clickFeeCents, leads: p._count.townshipLeads,
        missing: ts.missingInfo(p, p._count.photos), live: ts.isLive(p, h, p._count.photos),
      };
    }),
    leads: leads.map(leadOut),
    lockedCount: leads.filter((l) => l.status === 'locked').length,
    payments: payments.map((p) => ({ id: p.id, kind: p.kind, months: p.months, propertyIds: p.propertyIds, method: p.method, amountCents: p.amountCents, status: p.status, createdAt: p.createdAt, note: p.note })),
  });
}));

// PATCH /host-township/plan { plan: 'monthly'|'click' }
host.patch('/plan', wrap(async (req, res) => {
  const b = req.body || {};
  if (!['monthly', 'click'].includes(b.plan)) return res.status(400).json({ error: 'bad_plan' });
  await prisma.host.update({ where: { id: req.hostId }, data: { tsPlan: b.plan } });
  const unlocked = await ts.unlockLocked(req.hostId);
  res.json({ ok: true, unlocked });
}));

// POST /host-township/topup { amountCents } — load credit for the click plan.
host.post('/topup', wrap(async (req, res) => {
  const amountCents = cents(req.body && req.body.amountCents);
  if (!amountCents || amountCents < 5000 || amountCents > 5000000) return res.status(400).json({ error: 'bad_amount', message: 'Top up between R50 and R50 000.' });
  const h = await prisma.host.findUnique({ where: { id: req.hostId } });
  res.json(await ts.startPayment(h, { kind: 'topup', amountCents, base: baseOf(req) }));
}));

// POST /host-township/pay-months { propertyId, months } — pay upfront for as many months
// of one listing as the host wants. They're added on from when its current paid time ends.
const MAX_MONTHS = 60;
host.post('/pay-months', wrap(async (req, res) => {
  const b = req.body || {};
  const months = Math.round(Number(b.months));
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) return res.status(400).json({ error: 'bad_months', message: `Choose between 1 and ${MAX_MONTHS} months.` });
  const p = await prisma.property.findFirst({ where: { id: String(b.propertyId || ''), hostId: req.hostId, kind: 'township' } });
  if (!p) return res.status(404).json({ error: 'not_found', message: 'That listing was not found.' });
  const fee = ts.feesFor(p, await ts.getSettings()).monthlyFeeCents;
  if (!fee) return res.status(400).json({ error: 'free', message: 'This listing has no monthly fee.' });
  const h = await prisma.host.findUnique({ where: { id: req.hostId } });
  res.json(await ts.startPayment(h, { kind: 'monthly', amountCents: fee * months, propertyIds: [p.id], months, base: baseOf(req) }));
}));

// ================= public =================
const pub = express.Router();

const liveInclude = { host: true, photos: { orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }], select: { id: true } } };

// GET /public/township — every live listing (each with its availableFrom date, if set).
pub.get('/', wrap(async (req, res) => {
  const now = new Date();
  const props = await prisma.property.findMany({
    where: { kind: 'township', tsHidden: false, host: { tsPlan: { not: null } } },
    orderBy: { createdAt: 'desc' }, include: liveInclude,
  });
  res.json({ listings: props.filter((p) => ts.isLive(p, p.host, p.photos.length, now)).map(ts.publicCard) });
}));

// GET /public/township/:id — one listing. Contact details are never included.
pub.get('/:id', wrap(async (req, res) => {
  const p = await prisma.property.findFirst({ where: { id: req.params.id, kind: 'township' }, include: liveInclude });
  if (!p || !ts.isLive(p, p.host, p.photos.length)) return res.status(404).json({ error: 'not_found' });
  res.json({ listing: {
    ...ts.publicCard(p),
    description: p.description || null, areaDescription: p.areaDescription || null,
    photos: p.photos.map((x) => x.id),
  } });
}));

// POST /public/township/:id/contact { phone? } — signed-in tenant asks for the details.
pub.post('/:id/contact', authGuest, wrap(async (req, res) => {
  res.json(await ts.revealContact({ guestId: req.guestId, propertyId: req.params.id, phone: req.body && req.body.phone }));
}));

// POST /public/township/:id/request { message? } — the host's clicks are off: ask to be contacted.
pub.post('/:id/request', authGuest, wrap(async (req, res) => {
  res.json(await ts.requestContact({ guestId: req.guestId, propertyId: req.params.id, message: req.body && req.body.message }));
}));

// GET /public/township/pay/go/:id — posts the host on to Paygate (the id is the capability).
pub.get('/pay/go/:id', wrap(async (req, res) => {
  const p = await prisma.townshipPayment.findUnique({ where: { id: req.params.id } });
  if (!p || p.status !== 'pending' || !p.providerRef) return res.status(404).type('html').send('<p style="font-family:sans-serif">This payment link has expired. Please start again from your Township Stays page.</p>');
  const c = paygate.config();
  const checksum = paygate.md5(`${c.paygateId}${p.providerRef}${p.id}${c.key}`);
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SimonStays · Secure payment</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px;color:#1f2a24">
<p>Taking you to Paygate’s secure payment page…</p>
<form id="f" method="POST" action="${paygate.PROCESS_URL}">
<input type="hidden" name="PAY_REQUEST_ID" value="${esc(p.providerRef)}"><input type="hidden" name="CHECKSUM" value="${esc(checksum)}">
<noscript><button type="submit">Continue to payment</button></noscript></form>
<script>document.getElementById('f').submit()</script></body></html>`);
}));

// GET|POST /public/township/pay/return/:id — back from Paygate: check, then to the host's screen.
pub.all('/pay/return/:id', async (req, res) => {
  const p = await prisma.townshipPayment.findUnique({ where: { id: req.params.id } }).catch(() => null);
  if (!p) return res.redirect(303, '/hosting/listings/township');
  let fresh = p;
  try { await ts.reconcile(p); fresh = await prisma.townshipPayment.findUnique({ where: { id: p.id } }); }
  catch (e) { console.error('[township] return reconcile failed', e.message); }
  const failed = ['DECLINED', 'CANCELLED', 'USER_CANCELLED', 'NOT_DONE', 'VOIDED'].includes(fresh.status);
  res.redirect(303, `/hosting/listings/township?${failed ? 'payment=cancelled' : 'paid=1'}`);
});

// ================= admin =================
const admin = express.Router();
admin.use(authHost, requireAdmin);

// GET /admin/township — fees, every Township host and listing, recent payments.
admin.get('/', wrap(async (req, res) => {
  const now = new Date();
  const settings = await ts.getSettings();
  const props = await prisma.property.findMany({
    where: { kind: 'township' }, orderBy: { createdAt: 'desc' },
    include: { host: true, _count: { select: { photos: true, townshipLeads: true } } },
  });
  const hostIds = [...new Set(props.map((p) => p.hostId))];
  const extraHosts = await prisma.host.findMany({ where: { tsPlan: { not: null }, id: { notIn: hostIds } } });
  const hosts = [...new Map([...props.map((p) => p.host), ...extraHosts].map((h) => [h.id, h])).values()];
  const hostRows = [];
  for (const h of hosts) {
    const [spent, leads, locked] = await Promise.all([
      ts.spentThisMonth(h.id, now),
      prisma.townshipLead.count({ where: { hostId: h.id, createdAt: { gte: ts.monthStart(now) } } }),
      prisma.townshipLead.count({ where: { hostId: h.id, status: 'locked' } }),
    ]);
    hostRows.push({ id: h.id, name: h.name, email: h.email, plan: h.tsPlan, creditCents: h.tsCreditCents,
      spentThisMonthCents: spent, leadsThisMonth: leads, lockedLeads: locked, cardLabel: h.tsCardLabel, activated: !!h.tsActivatedAt });
  }
  const payments = await prisma.townshipPayment.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { host: { select: { name: true, email: true } } } });
  res.json({
    settings,
    hosts: hostRows,
    listings: props.map((p) => ({
      id: p.id, name: p.name, areaName: p.areaName, hostId: p.hostId, hostName: p.host.name || p.host.email,
      tsMonthlyFeeCents: p.tsMonthlyFeeCents, tsClickFeeCents: p.tsClickFeeCents, paidUntil: p.tsPaidUntil, hidden: p.tsHidden,
      leads: p._count.townshipLeads, live: ts.isLive(p, p.host, p._count.photos), missing: ts.missingInfo(p, p._count.photos),
    })),
    payments: payments.map((p) => ({ id: p.id, host: p.host.name || p.host.email, kind: p.kind, months: p.months, method: p.method, amountCents: p.amountCents, status: p.status, createdAt: p.createdAt, note: p.note })),
  });
}));

// PUT /admin/township/settings { monthlyFeeCents, clickFeeCents }
admin.put('/settings', wrap(async (req, res) => {
  res.json({ settings: await ts.saveSettings(req.body || {}) });
}));

// PATCH /admin/township/listings/:id { tsMonthlyFeeCents, tsClickFeeCents } — per-listing overrides (blank = default).
admin.patch('/listings/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const data = {};
  if ('tsMonthlyFeeCents' in b) data.tsMonthlyFeeCents = cents(b.tsMonthlyFeeCents);
  if ('tsClickFeeCents' in b) data.tsClickFeeCents = cents(b.tsClickFeeCents);
  const p = await prisma.property.updateMany({ where: { id: req.params.id, kind: 'township' }, data });
  if (!p.count) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
}));

// POST /admin/township/hosts/:id/credit { amountCents, note } — add credit by hand (e.g. paid by EFT).
admin.post('/hosts/:id/credit', wrap(async (req, res) => {
  const amountCents = Math.round(Number(req.body && req.body.amountCents));
  if (!Number.isInteger(amountCents) || amountCents === 0) return res.status(400).json({ error: 'bad_amount' });
  const h = await prisma.host.findUnique({ where: { id: req.params.id } });
  if (!h) return res.status(404).json({ error: 'not_found' });
  const tp = await prisma.townshipPayment.create({ data: {
    hostId: h.id, kind: 'topup', method: 'admin', amountCents, status: 'COMPLETE',
    note: String((req.body && req.body.note) || 'Added in Platform admin').slice(0, 200),
  } });
  await ts.applyPayment(tp.id);
  res.json({ ok: true });
}));

// POST /admin/township/listings/:id/month { months, note } — mark months paid by hand (e.g. EFT).
admin.post('/listings/:id/month', wrap(async (req, res) => {
  const p = await prisma.property.findFirst({ where: { id: req.params.id, kind: 'township' } });
  if (!p) return res.status(404).json({ error: 'not_found' });
  const months = Math.min(Math.max(Math.round(Number(req.body && req.body.months)) || 1, 1), MAX_MONTHS);
  const fee = ts.feesFor(p, await ts.getSettings()).monthlyFeeCents;
  const tp = await prisma.townshipPayment.create({ data: {
    hostId: p.hostId, kind: 'monthly', method: 'admin', amountCents: fee * months, months, propertyIds: [p.id], status: 'COMPLETE',
    note: String((req.body && req.body.note) || 'Marked paid in Platform admin').slice(0, 200),
  } });
  await ts.applyPayment(tp.id);
  res.json({ ok: true });
}));

module.exports = { host, pub, admin };
