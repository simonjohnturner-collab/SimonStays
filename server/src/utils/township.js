// Township Stays: longer rentals listed on /township. Tenants pay nothing; the host
// pays to be found, on one of two plans (Host.tsPlan):
//   monthly — the host pays upfront for as many months as they choose, per listing
//             (Property.tsPaidUntil). Contact clicks are free while paid. No card is saved
//             and nothing renews by itself: the host is reminded to pay for more.
//   click   — prepaid credit (Host.tsCreditCents), shared by all their listings. Each
//             signed-in tenant who asks for a listing's contact details costs one click fee,
//             at most once per tenant per listing per 30 days. No spending cap: the credit is the limit.
// Once a listing has been paid for, it stays up until the host removes it. When the paid
// months end or the credit runs out, the Contact button switches off: a tenant can still
// ask to be contacted, the host is told someone's interested (without their details) and
// asked to remove the listing if it's taken. The details unlock once the host pays.
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
function addMonth(d, n = 1) { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; }

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
// Is this listing paid up right now (monthly: within its paid months; click: plan started)?
function planActive(p, host, now = new Date()) {
  if (host.tsPlan === 'monthly') return !!(p.tsPaidUntil && new Date(p.tsPaidUntil) > now);
  if (host.tsPlan === 'click') return !!host.tsActivatedAt;
  return false;
}
// Has the host ever paid for it? A listing goes up on its first payment and then stays
// up (even once the months or credit run out) until the host removes it.
function everPaid(p, host) {
  return !!(host.tsPlan && (host.tsActivatedAt || p.tsPaidUntil));
}
function isLive(p, host, photoCount) {
  return p.kind === 'township' && !p.tsHidden && missingInfo(p, photoCount).length === 0 && everPaid(p, host);
}
// Can a tenant see this listing's contact details right now (without the host paying)?
async function clicksOpen(host, fee, now = new Date(), p = null) {
  if (host.tsPlan === 'monthly') return p ? planActive(p, host, now) : true;
  if (host.tsPlan !== 'click') return false;
  return (host.tsCreditCents || 0) >= fee;
}
// Take one click fee off the host's credit, if there's enough.
async function charge(host, fee) {
  if (fee <= 0) return true;
  const r = await prisma.host.updateMany({ where: { id: host.id, tsCreditCents: { gte: fee } }, data: { tsCreditCents: { decrement: fee } } });
  return r.count === 1;
}

const contactOf = (p, host) => ({
  name: p.contactName || host.name || null,
  phone: p.contactPhone || null,
  email: p.contactEmail || null,
});

// ---- notifying the host: always email AND WhatsApp ----
// WhatsApp goes to the host's account phone, or failing that the contact phone on
// one of their Township listings (every live listing has one).
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
  try {
    const listing = await prisma.property.findFirst({ where: { hostId: host.id, kind: 'township', contactPhone: { not: null } }, orderBy: { createdAt: 'asc' }, select: { contactPhone: true } });
    await require('./payments').alertHost({ hostId: host.id, fallbackPhone: listing ? listing.contactPhone : null }, `${subject}\n${lines.join('\n')}\n${link}`);
  } catch (e) { console.error('[township] WhatsApp to host failed', e.message); }
}
// A click-plan host's credit just ran out (told once, right after the last click it paid for).
async function notifySwitchedOff(host) {
  await notifyHost(host, {
    subject: 'Township Stays: your credit has run out',
    lines: [`Your Township Stays credit has run out (${rand(host.tsCreditCents || 0)} left), so tenants can't see your contact details.`,
      "Your listings stay up. When a tenant is interested we'll let you know, and you can top up to get their details.",
      'If a place has been rented, please remove it from Township Stays so you stop getting these messages.'],
  });
}
const fmtDay = (d) => new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });

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
  if (!(await clicksOpen(p.host, fee, now, p)) || !(await charge(p.host, fee))) {
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
    if (!(await clicksOpen(fresh, fee, now))) await notifySwitchedOff(fresh);
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
  const pay = p.host.tsPlan === 'monthly'
    ? `Your paid listing time${p.tsPaidUntil ? ` ended on ${fmtDay(p.tsPaidUntil)}` : ' has ended'}. Pay for more months to see their contact details.`
    : `Your credit has run out. Top up to see their contact details (${rand(feesFor(p, await getSettings()).clickFeeCents)} per tenant).`;
  await notifyHost(p.host, {
    subject: `Township Stays: someone is interested in ${p.name}`,
    lines: [`A tenant is interested in ${p.name}${p.areaName ? ` (${p.areaName})` : ''} and has asked you to contact them.`,
      pay + (waiting > 1 ? ` ${waiting} tenants are waiting.` : ''),
      `If ${p.name} has been rented, please remove it from Township Stays so you stop getting these messages.`],
  });
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
    if (!(await charge(host, fee))) break;
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
async function startPayment(host, { kind, amountCents, propertyIds = [], months = null, base }) {
  const tp = await prisma.townshipPayment.create({ data: { hostId: host.id, kind, amountCents, propertyIds, months, method: 'card' } });
  if (!paygate.ready() || !base) {
    await prisma.townshipPayment.update({ where: { id: tp.id }, data: { status: 'COMPLETE', note: 'Simulated (payments not live)' } });
    await applyPayment(tp.id);
    return { mode: 'simulate', paymentId: tp.id };
  }
  const init = await paygate.initiate({
    reference: tp.id, amountCents, email: await hostEmail(host), user1: `township-${kind}`,
    returnUrl: `${base}/public/township/pay/return/${tp.id}`,
    notifyUrl: `${base}/public/paygate/notify`,
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
      await prisma.property.update({ where: { id: p.id }, data: { tsPaidUntil: addMonth(from, Math.max(1, tp.months || 1)) } });
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

// Daily: monthly-plan listings whose paid months end in 3 days or today. Nothing is
// charged automatically; the host is reminded (email + WhatsApp) to pay for more.
async function runDaily(now = new Date()) {
  const hosts = await prisma.host.findMany({ where: { tsPlan: 'monthly' } });
  const out = { reminded: 0 };
  const inWindow = (d, fromDays, toDays) => d > new Date(now.getTime() + fromDays * DAY) && d <= new Date(now.getTime() + toDays * DAY);
  for (const host of hosts) {
    // Each window is one day wide, so a once-a-day run reminds about each listing exactly twice.
    const props = await prisma.property.findMany({ where: { hostId: host.id, kind: 'township', tsHidden: false, tsPaidUntil: { not: null, gt: now, lte: new Date(now.getTime() + 3 * DAY) } } });
    const last = props.filter((p) => inWindow(new Date(p.tsPaidUntil), 0, 1));
    const inThree = props.filter((p) => inWindow(new Date(p.tsPaidUntil), 2, 3));
    const remind = last.length ? last : inThree;
    if (!remind.length) continue;
    const names = remind.map((p) => p.name).join(', ');
    await notifyHost(host, {
      subject: last.length ? 'Township Stays: your paid listing time ends within a day' : 'Township Stays: your paid listing time ends in 3 days',
      lines: [`Your paid time for ${names} ends on ${fmtDay(remind[0].tsPaidUntil)}.`,
        "Your listing stays up, but after that tenants won't see your contact details. We'll tell you when someone is interested, and you can pay for more months to get their details.",
        'Pay for more months on your Township Stays page. If the place has been rented, please remove it from Township Stays.'],
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
    availableFrom: p.availableFrom ? new Date(p.availableFrom).toISOString().slice(0, 10) : null,
  };
}

module.exports = {
  DEFAULTS, REPEAT_WINDOW_DAYS, getSettings, saveSettings, feesFor, monthStart, monthKey, spentThisMonth,
  missingInfo, planActive, everPaid, isLive, addMonth, clicksOpen, revealContact, requestContact, unlockLocked,
  startPayment, applyPayment, reconcile, handleNotify, monthlyDue, runDaily, publicCard, notifySwitchedOff,
};
