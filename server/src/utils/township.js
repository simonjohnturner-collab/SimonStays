// Township Stays: longer rentals listed on /township. Tenants pay nothing; the host
// pays to be found, on one of two plans (Host.tsPlan):
//   monthly — a fee per listing per month (Property.tsPaidUntil). Contact clicks are free.
//   click   — prepaid credit (Host.tsCreditCents). Each signed-in tenant who asks for a
//             listing's contact details costs the host one click fee, at most once per
//             tenant per listing per 30 days, up to the host's monthly maximum.
// When a click-plan host's credit runs out or their maximum is reached, the Contact
// button switches off. A tenant can still ask to be contacted: that becomes a 'locked'
// lead whose details unlock (and are charged) once the host tops up.
// Simon sets the fees in Platform admin (PlatformSetting), with per-listing overrides.
const prisma = require('../lib/prisma');
const paygate = require('./paygate');

const DEFAULTS = { monthlyFeeCents: 19900, clickFeeCents: 1000 };
const KEYS = { monthlyFeeCents: 'township.monthlyFeeCents', clickFeeCents: 'township.clickFeeCents' };
const DAY = 24 * 3600 * 1000;
const REPEAT_WINDOW_DAYS = 30; // one charge per tenant per listing in this window
const SITE = () => (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
const rand = (c) => 'R' + (Math.round(c) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- settings ----
async function getSettings() {
  const rows = await prisma.platformSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const out = { ...DEFAULTS };
  for (const [k, key] of Object.entries(KEYS)) {
    const r = rows.find((x) => x.key === key);
    if (r && Number.isInteger(Number(r.value))) out[k] = Number(r.value);
  }
  return out;
}
async function saveSettings(patch) {
  for (const [k, key] of Object.entries(KEYS)) {
    if (!(k in patch)) continue;
    const v = Math.max(0, Math.round(Number(patch[k])));
    if (!Number.isFinite(v)) continue;
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
  }
  return getSettings();
}
const feesFor = (p, s) => ({
  monthlyFeeCents: p.tsMonthlyFeeCents ?? s.monthlyFeeCents,
  clickFeeCents: p.tsClickFeeCents ?? s.clickFeeCents,
});

// ---- months (South African time) ----
const SAST = 2 * 3600 * 1000;
function monthStart(now = new Date()) {
  const l = new Date(now.getTime() + SAST);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1) - SAST);
}
function monthKey(now = new Date()) { return new Date(now.getTime() + SAST).toISOString().slice(0, 7); }
function addMonth(d) { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + 1); return x; }

async function spentThisMonth(hostId, now = new Date()) {
  const r = await prisma.townshipLead.aggregate({ where: { hostId, chargedAt: { gte: monthStart(now) } }, _sum: { feeCents: true } });
  return r._sum.feeCents || 0;
}

// ---- is a listing live? ----
// What a listing still needs before it can go on Township Stays (the host's checklist).
function missingInfo(p, photoCount) {
  const m = [];
  if (!String(p.name || '').trim()) m.push('a name');
  if (!p.monthlyRentCents && !p.weeklyRentCents) m.push('a monthly or weekly rent');
  if (!p.contactPhone && !p.contactEmail) m.push('a contact phone or email');
  if (!photoCount) m.push('at least one photo');
  return m;
}
function planActive(p, host, now = new Date()) {
  if (host.tsPlan === 'monthly') return !!(p.tsPaidUntil && new Date(p.tsPaidUntil) > now);
  if (host.tsPlan === 'click') return !!host.tsActivatedAt;
  return false;
}
function isLive(p, host, photoCount, now = new Date()) {
  return p.kind === 'township' && !p.tsHidden && missingInfo(p, photoCount).length === 0 && planActive(p, host, now);
}
// Can a tenant see the contact details right now (without the host topping up)?
async function clicksOpen(host, fee, now = new Date()) {
  if (host.tsPlan === 'monthly') return true;
  if (host.tsPlan !== 'click') return false;
  if ((host.tsCreditCents || 0) < fee) return false;
  if (host.tsMonthlyCapCents != null && (await spentThisMonth(host.id, now)) + fee > host.tsMonthlyCapCents) return false;
  return true;
}
// Take one click fee off the host's credit, if the credit and their maximum allow.
async function charge(host, fee, now = new Date()) {
  if (fee <= 0) return true;
  if (host.tsMonthlyCapCents != null && (await spentThisMonth(host.id, now)) + fee > host.tsMonthlyCapCents) return false;
  const r = await prisma.host.updateMany({ where: { id: host.id, tsCreditCents: { gte: fee } }, data: { tsCreditCents: { decrement: fee } } });
  return r.count === 1;
}

const contactOf = (p, host) => ({
  name: p.contactName || host.name || null,
  phone: p.contactPhone || null,
  email: p.contactEmail || null,
});

// ---- notifying the host ----
async function notifyHost(host, { subject, lines, html }) {
  const link = `${SITE()}/hosting/listings/township`;
  try {
    const { sendMail, isEnabled } = require('./mailer');
    if (isEnabled() && host.email) {
      const body = html || lines.map((l) => `<p>${esc(l)}</p>`).join('');
      await sendMail({
        to: host.email, subject,
        text: `${lines.join('\n\n')}\n\nSee your Township Stays: ${link}`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#1f2a24">${body}<p><a href="${link}">See your Township Stays</a></p></div>`,
      });
    }
  } catch (e) { console.error('[township] email to host failed', e.message); }
  try { await require('./payments').alertHost({ hostId: host.id }, `${subject}\n${lines.join('\n')}\n${link}`); } catch (e) { /* best effort */ }
}
async function notifySwitchedOff(host, now = new Date()) {
  const key = monthKey(now);
  const capHit = host.tsMonthlyCapCents != null && (await spentThisMonth(host.id, now)) >= host.tsMonthlyCapCents;
  // Out of credit is told every time; the monthly maximum once a month.
  if (capHit && host.tsCapNotified === key) return;
  if (capHit) await prisma.host.update({ where: { id: host.id }, data: { tsCapNotified: key } });
  await notifyHost(host, {
    subject: 'Township Stays: your Contact button is switched off',
    lines: [capHit
      ? `You've reached the monthly maximum you set (${rand(host.tsMonthlyCapCents)}), so tenants can't see your contact details until next month.`
      : `Your Township Stays credit has run out (${rand(host.tsCreditCents || 0)} left), so tenants can't see your contact details.`,
      'Tenants can still ask you to contact them. Their details unlock as soon as you ' + (capHit ? 'raise your maximum or the new month starts.' : 'top up.')],
  });
}

// ---- tenant actions ----
async function loadListing(propertyId) {
  const p = await prisma.property.findFirst({
    where: { id: propertyId, kind: 'township' },
    include: { host: true, _count: { select: { photos: true } } },
  });
  return p;
}
const recentLead = (propertyId, guestId, now, statuses) => prisma.townshipLead.findFirst({
  where: { propertyId, guestAccountId: guestId, createdAt: { gte: new Date(now.getTime() - REPEAT_WINDOW_DAYS * DAY) }, ...(statuses ? { status: { in: statuses } } : {}) },
  orderBy: { createdAt: 'desc' },
});

// A signed-in tenant taps "Contact details". Answers { status: 'open', contact } |
// { status: 'closed' } (the host's clicks are off) | { status: 'need_phone' }.
async function revealContact({ guestId, propertyId, phone, now = new Date() }) {
  const p = await loadListing(propertyId);
  if (!p || !isLive(p, p.host, p._count.photos, now)) { const e = new Error('This listing is not available.'); e.status = 404; throw e; }
  const acct = await prisma.guestAccount.findUnique({ where: { id: guestId } });
  if (!acct) { const e = new Error('Please sign in again.'); e.status = 401; throw e; }
  const tel = String(phone || '').trim();
  if (!acct.phone && tel) await prisma.guestAccount.update({ where: { id: acct.id }, data: { phone: tel.slice(0, 40) } });
  const myPhone = acct.phone || tel;
  if (!myPhone) return { status: 'need_phone' };

  if (await recentLead(p.id, acct.id, now, ['open'])) return { status: 'open', contact: contactOf(p, p.host) };

  const settings = await getSettings();
  const fee = p.host.tsPlan === 'click' ? feesFor(p, settings).clickFeeCents : 0;
  if (!(await clicksOpen(p.host, fee, now)) || !(await charge(p.host, fee, now))) {
    return { status: 'closed', requested: !!(await recentLead(p.id, acct.id, now, ['locked'])) };
  }
  const lead = await prisma.townshipLead.create({ data: {
    propertyId: p.id, hostId: p.hostId, guestAccountId: acct.id, name: acct.name, phone: myPhone, email: acct.email,
    status: 'open', feeCents: fee, chargedAt: fee ? now : null,
  } });
  await notifyHost(p.host, {
    subject: `Township Stays: ${acct.name || 'Someone'} asked for your contact details`,
    lines: [`${acct.name || 'A tenant'} is interested in ${p.name}${p.areaName ? ` (${p.areaName})` : ''} and now has your contact details.`,
      `Their details: ${[acct.name, myPhone, acct.email].filter(Boolean).join(' · ')}`,
      fee ? `This click cost ${rand(fee)}.` : ''].filter(Boolean),
  });
  if (fee) {
    const fresh = await prisma.host.findUnique({ where: { id: p.hostId } });
    if (!(await clicksOpen(fresh, fee, now))) await notifySwitchedOff(fresh, now);
  }
  return { status: 'open', contact: contactOf(p, p.host), leadId: lead.id };
}

// The host's clicks are off: the tenant asks to be contacted. The host is told
// someone is interested; the tenant's details unlock when the host tops up.
async function requestContact({ guestId, propertyId, message, now = new Date() }) {
  const p = await loadListing(propertyId);
  if (!p || !isLive(p, p.host, p._count.photos, now)) { const e = new Error('This listing is not available.'); e.status = 404; throw e; }
  const acct = await prisma.guestAccount.findUnique({ where: { id: guestId } });
  if (!acct) { const e = new Error('Please sign in again.'); e.status = 401; throw e; }
  if (await recentLead(p.id, acct.id, now)) return { ok: true, already: true };
  await prisma.townshipLead.create({ data: {
    propertyId: p.id, hostId: p.hostId, guestAccountId: acct.id, name: acct.name, phone: acct.phone, email: acct.email,
    message: String(message || '').trim().slice(0, 1000) || null, status: 'locked',
  } });
  const waiting = await prisma.townshipLead.count({ where: { hostId: p.hostId, status: 'locked' } });
  await notifyHost(p.host, {
    subject: `Township Stays: someone is interested in ${p.name}`,
    lines: [`A tenant has asked you to contact them about ${p.name}${p.areaName ? ` (${p.areaName})` : ''}.`,
      `Your Contact button is switched off, so their details are locked. ${waiting === 1 ? 'They unlock' : `All ${waiting} waiting tenants unlock`} as soon as you top up${p.host.tsMonthlyCapCents != null ? ' or raise your monthly maximum' : ''}.`],
  });
  await notifySwitchedOff(p.host, now);
  return { ok: true };
}

// After a top-up, a raised maximum or a move to the monthly plan: unlock waiting
// tenants, oldest first, charging each while the credit and maximum allow.
async function unlockLocked(hostId, now = new Date()) {
  const settings = await getSettings();
  const locked = await prisma.townshipLead.findMany({ where: { hostId, status: 'locked' }, orderBy: { createdAt: 'asc' }, include: { property: true } });
  const unlocked = [];
  for (const l of locked) {
    const host = await prisma.host.findUnique({ where: { id: hostId } });
    const fee = host.tsPlan === 'click' ? feesFor(l.property, settings).clickFeeCents : 0;
    if (host.tsPlan !== 'monthly' && host.tsPlan !== 'click') break;
    if (host.tsPlan === 'monthly' && !planActive(l.property, host, now)) continue;
    if (!(await charge(host, fee, now))) break;
    const ok = await prisma.townshipLead.updateMany({ where: { id: l.id, status: 'locked' }, data: { status: 'open', feeCents: fee, chargedAt: fee ? now : null } });
    if (ok.count) unlocked.push({ ...l, feeCents: fee });
    else if (fee) await prisma.host.update({ where: { id: hostId }, data: { tsCreditCents: { increment: fee } } }); // someone else unlocked it
  }
  if (unlocked.length) {
    const host = await prisma.host.findUnique({ where: { id: hostId } });
    await notifyHost(host, {
      subject: `Township Stays: ${unlocked.length} tenant${unlocked.length === 1 ? '' : 's'} unlocked`,
      lines: ['These tenants asked you to contact them:',
        ...unlocked.map((l) => `${l.property.name}: ${[l.name, l.phone, l.email].filter(Boolean).join(' · ')}${l.message ? ` — "${l.message}"` : ''}`)],
    });
  }
  return unlocked.length;
}

// ---- payments ----
async function hostEmail(host) { return host.email || 'support@simonstays.co.za'; }

// Start a top-up or a month of listing fees. Returns { mode:'simulate' } (applied at
// once, for testing) or { mode:'form', action, fields, goUrl } for Paygate's page.
async function startPayment(host, { kind, amountCents, propertyIds = [], base }) {
  const tp = await prisma.townshipPayment.create({ data: { hostId: host.id, kind, amountCents, propertyIds, method: 'card' } });
  if (!paygate.ready() || !base) {
    await prisma.townshipPayment.update({ where: { id: tp.id }, data: { status: 'COMPLETE', note: 'Simulated (payments not live)' } });
    await applyPayment(tp.id);
    return { mode: 'simulate', paymentId: tp.id };
  }
  const init = await paygate.initiate({
    reference: tp.id, amountCents, email: await hostEmail(host), user1: `township-${kind}`,
    returnUrl: `${base}/public/township/pay/return/${tp.id}`,
    notifyUrl: `${base}/public/paygate/notify`,
    vault: paygate.vaultReady(),
  });
  await prisma.townshipPayment.update({ where: { id: tp.id }, data: { providerRef: init.payRequestId } });
  return { mode: 'form', paymentId: tp.id, ...init.form, goUrl: `${base}/public/township/pay/go/${tp.id}` };
}

// Apply a COMPLETE payment exactly once.
async function applyPayment(id, now = new Date()) {
  const claimed = await prisma.townshipPayment.updateMany({ where: { id, status: 'COMPLETE', appliedAt: null }, data: { appliedAt: now } });
  if (!claimed.count) return false;
  const tp = await prisma.townshipPayment.findUnique({ where: { id } });
  const host = await prisma.host.findUnique({ where: { id: tp.hostId } });
  const data = { tsActivatedAt: host.tsActivatedAt || now };
  const raw = tp.raw || {};
  if (raw.VAULT_ID) {
    data.tsVaultId = raw.VAULT_ID;
    data.tsCardLabel = [raw.PAY_METHOD_DETAIL, raw.PAYVAULT_DATA_1 && String(raw.PAYVAULT_DATA_1).slice(-4)].filter(Boolean).join(' ') || 'Saved card';
  }
  if (tp.kind === 'topup') {
    data.tsCreditCents = { increment: tp.amountCents };
    data.tsCapNotified = null;
  }
  await prisma.host.update({ where: { id: host.id }, data });
  if (tp.kind === 'monthly') {
    const ids = Array.isArray(tp.propertyIds) ? tp.propertyIds : [];
    const props = await prisma.property.findMany({ where: { id: { in: ids }, hostId: host.id, kind: 'township' } });
    for (const p of props) {
      const from = p.tsPaidUntil && new Date(p.tsPaidUntil) > now ? new Date(p.tsPaidUntil) : now;
      await prisma.property.update({ where: { id: p.id }, data: { tsPaidUntil: addMonth(from) } });
    }
  }
  await unlockLocked(host.id, now).catch((e) => console.error('[township] unlock failed', e.message));
  return true;
}

// Ask Paygate how a payment went (notify, return page) and apply it.
async function reconcile(tp, { query = paygate.query } = {}) {
  if (!tp || !tp.providerRef) return { ok: false, reason: 'not_started' };
  if (tp.status !== 'pending') return { ok: true, outcome: 'already_applied' };
  const q = await query({ payRequestId: tp.providerRef, reference: tp.id });
  if (q.status === 'PENDING' || q.status === 'RECEIVED') return { ok: true, outcome: 'pending' };
  if (q.status === 'APPROVED' && q.amountCents !== tp.amountCents) {
    console.error('[township] amount mismatch', tp.id, q.amountCents, tp.amountCents);
    return { ok: false, reason: 'amount_mismatch' };
  }
  const status = q.status === 'APPROVED' ? 'COMPLETE' : q.status;
  const claimed = await prisma.townshipPayment.updateMany({ where: { id: tp.id, status: 'pending' }, data: { status, raw: q.data || null } });
  if (!claimed.count) return { ok: true, outcome: 'already_applied' };
  if (status === 'COMPLETE') await applyPayment(tp.id);
  return { ok: true, outcome: status.toLowerCase() };
}

// Paygate's notify for one of these payments (the shared notify URL calls this
// when the reference isn't a booking payment).
async function handleNotify(rawBody) {
  const c = paygate.config();
  if (!paygate.validPayload(rawBody)) return { ok: false, reason: 'bad_checksum' };
  const d = Object.fromEntries(new URLSearchParams(rawBody));
  if (d.PAYGATE_ID !== c.paygateId) return { ok: false, reason: 'wrong_merchant' };
  const tp = d.REFERENCE ? await prisma.townshipPayment.findUnique({ where: { id: d.REFERENCE } }) : null;
  if (!tp || tp.providerRef !== d.PAY_REQUEST_ID) return { ok: false, reason: 'unknown_payment' };
  return reconcile(tp);
}

// The host's listings that a month's fee would cover, and what it costs.
async function monthlyDue(hostId, settings) {
  const s = settings || await getSettings();
  const props = await prisma.property.findMany({ where: { hostId, kind: 'township', tsHidden: false }, orderBy: { createdAt: 'asc' } });
  const items = props.map((p) => ({ id: p.id, name: p.name, feeCents: feesFor(p, s).monthlyFeeCents, paidUntil: p.tsPaidUntil }));
  return { items, totalCents: items.reduce((a, x) => a + x.feeCents, 0) };
}

// Daily: monthly-plan listings coming up for renewal. With a saved card (Vault),
// charge it on the day; otherwise email the host a reminder 3 days before and on the day.
async function runDaily(now = new Date()) {
  const settings = await getSettings();
  const hosts = await prisma.host.findMany({ where: { tsPlan: 'monthly' } });
  const out = { charged: 0, reminded: 0, failed: 0 };
  for (const host of hosts) {
    const props = await prisma.property.findMany({ where: { hostId: host.id, kind: 'township', tsHidden: false, tsPaidUntil: { not: null, lte: new Date(now.getTime() + 3 * DAY) } } });
    if (!props.length) continue;
    const dueToday = props.filter((p) => new Date(p.tsPaidUntil) <= new Date(now.getTime() + DAY) && new Date(p.tsPaidUntil) > new Date(now.getTime() - DAY));
    const inThree = props.filter((p) => new Date(p.tsPaidUntil) > new Date(now.getTime() + 2 * DAY));
    if (dueToday.length && host.tsVaultId && paygate.vaultReady()) {
      const amountCents = dueToday.reduce((a, p) => a + feesFor(p, settings).monthlyFeeCents, 0);
      const tp = await prisma.townshipPayment.create({ data: { hostId: host.id, kind: 'monthly', method: 'vault', amountCents, propertyIds: dueToday.map((p) => p.id) } });
      const r = await paygate.vaultCharge({ vaultId: host.tsVaultId, reference: tp.id, amountCents, email: await hostEmail(host), name: host.name });
      if (r.outcome === 'approved') {
        await prisma.townshipPayment.update({ where: { id: tp.id }, data: { status: 'COMPLETE', providerRef: r.transactionId ? `vault-${r.transactionId}` : null, note: r.message } });
        await applyPayment(tp.id, now); out.charged++;
        await notifyHost(host, { subject: 'Township Stays: monthly fee paid', lines: [`We charged ${rand(amountCents)} to your saved card for another month of ${dueToday.map((p) => p.name).join(', ')}.`] });
        continue;
      }
      await prisma.townshipPayment.update({ where: { id: tp.id }, data: { status: r.outcome === 'declined' ? 'DECLINED' : 'FAILED', note: r.message } });
      out.failed++;
    }
    const remind = dueToday.length ? dueToday : inThree;
    if (!remind.length) continue;
    const amountCents = remind.reduce((a, p) => a + feesFor(p, settings).monthlyFeeCents, 0);
    await notifyHost(host, {
      subject: dueToday.length ? 'Township Stays: your listings need this month’s fee' : 'Township Stays: monthly fee due in 3 days',
      lines: [`${remind.map((p) => p.name).join(', ')} ${dueToday.length ? 'come off Township Stays today' : 'come off Township Stays in 3 days'} unless this month's fee (${rand(amountCents)}) is paid.`,
        'Pay it from your Township Stays page.'],
    });
    out.reminded++;
  }
  return out;
}

// Public card / detail shapes.
function publicCard(p) {
  const cover = (p.photos || [])[0];
  return {
    id: p.id, name: p.name, areaName: p.areaName || null, address: p.address || null,
    latitude: p.latitude ?? null, longitude: p.longitude ?? null,
    coverPhotoId: cover ? cover.id : null,
    monthlyRentCents: p.monthlyRentCents ?? null, weeklyRentCents: p.weeklyRentCents ?? null, depositCents: p.depositCents ?? null,
    hostName: p.host && p.host.name ? String(p.host.name).split(' ')[0] : null,
  };
}

module.exports = {
  DEFAULTS, REPEAT_WINDOW_DAYS, getSettings, saveSettings, feesFor, monthStart, monthKey, spentThisMonth,
  missingInfo, planActive, isLive, clicksOpen, revealContact, requestContact, unlockLocked,
  startPayment, applyPayment, reconcile, handleNotify, monthlyDue, runDaily, publicCard, notifySwitchedOff,
};
