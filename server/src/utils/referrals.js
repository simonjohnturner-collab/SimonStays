// Growth: the 5% welcome discount for fully signed-up guests, and the R1 000
// reward for referring a new host.
//
// Welcome discount: 5% off the stay (not the cleaning fee or the breakage deposit) on a guest's
// first SimonStays booking, once their account is complete (email confirmed,
// photo and ID uploaded). SimonStays bears it: the host is paid on the full
// price (see utils/fees.js).
//
// Host referrals: anyone signed in (guest or host) has a link,
// /host?ref=CODE. A new host who signs up through it is recorded against the
// referrer, who earns R1 000 once that host's first paid SimonStays stay is
// over. The admin pays it by hand and marks it paid.
const crypto = require('crypto');
const prisma = require('../lib/prisma');

const WELCOME_PERCENT = 5;
const REFERRAL_CENTS = 100000; // R1 000
const SHOP = () => (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
const linkFor = (code) => `${SHOP()}/host?ref=${code}`;

// ---- Welcome discount ----

// Where a guest stands with the welcome discount: { eligible, used, missing }.
// missing lists what's still needed before booking: 'signin', 'email' (not
// confirmed yet), 'photo', 'id'. used = they've already had a first booking.
async function welcomeStatus(guestAccountId) {
  if (!guestAccountId) return { eligible: false, used: false, missing: ['signin'] };
  const acct = await prisma.guestAccount.findUnique({ where: { id: guestAccountId }, include: { documents: { select: { kind: true } } } });
  if (!acct) return { eligible: false, used: false, missing: ['signin'] };
  const earlier = await prisma.booking.count({
    where: {
      source: 'website',
      OR: [{ guestAccountId: acct.id }, { guestEmail: { equals: acct.email, mode: 'insensitive' } }],
      AND: [{ OR: [{ status: 'confirmed' }, { status: 'pending', welcomeDiscountCents: { gt: 0 } }] }],
    },
  });
  if (earlier > 0) return { eligible: false, used: true, missing: [] };
  const kinds = new Set(acct.documents.map((d) => d.kind));
  const missing = [];
  if (!acct.emailVerifiedAt) missing.push('email');
  if (!kinds.has('photo')) missing.push('photo');
  if (!kinds.has('id')) missing.push('id');
  return { eligible: missing.length === 0, used: false, missing };
}

// Can this guest have the welcome discount? Their account is complete and they
// haven't had a SimonStays booking yet (or one already holding the discount).
async function welcomeEligible(guestAccountId) {
  return (await welcomeStatus(guestAccountId)).eligible;
}

// The discount a quote would get: 5% of the stay, leaving out the cleaning fee
// (and the deposit, which isn't in rentalCents).
const welcomeCentsOf = (q) => Math.max(0, Math.round(((q.rentalCents || 0) - (q.cleaningCents || 0)) * WELCOME_PERCENT / 100));

// Price a shopfront quote for this guest (in place): take the discount off if
// they're due it, and otherwise say what it would be and what's still needed,
// so the booking page can tell them before they book. Not shown once used.
async function welcomeForQuote(q, guestAccountId) {
  if (!q) return q;
  const s = await welcomeStatus(guestAccountId);
  if (s.eligible) return applyWelcome(q);
  if (!s.used) q.welcome = { percent: WELCOME_PERCENT, cents: welcomeCentsOf(q), missing: s.missing };
  return q;
}

// Take the welcome discount off a shopfront quote (in place). Neither the
// cleaning fee nor the deposit is discounted.
function applyWelcome(q) {
  if (!q) return q;
  const cents = welcomeCentsOf(q);
  if (cents <= 0) return q;
  q.welcomeDiscountCents = cents;
  q.welcomePercent = WELCOME_PERCENT;
  q.rentalCents -= cents;
  q.totalCents -= cents;
  if (q.withoutBubble) { q.withoutBubble.rentalCents -= cents; q.withoutBubble.totalCents -= cents; }
  return q;
}

// ---- Referral links ----

const newCode = () => crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, '').toUpperCase().slice(0, 7) || crypto.randomBytes(4).toString('hex').toUpperCase();

// The referral code of a guest account or a host, made the first time it's asked for.
async function codeFor({ guestAccountId, hostId }) {
  const model = guestAccountId ? prisma.guestAccount : prisma.host;
  const id = guestAccountId || hostId;
  const row = await model.findUnique({ where: { id }, select: { referralCode: true } });
  if (!row) return null;
  if (row.referralCode) return row.referralCode;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const taken = await prisma.guestAccount.findUnique({ where: { referralCode: code } }) || await prisma.host.findUnique({ where: { referralCode: code } });
    if (taken) continue;
    await model.update({ where: { id }, data: { referralCode: code } });
    return code;
  }
  return null;
}

// Who a code belongs to: { guestAccountId } or { hostId }, or null.
async function ownerOf(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(c)) return null;
  const g = await prisma.guestAccount.findUnique({ where: { referralCode: c }, select: { id: true, email: true } });
  if (g) return { code: c, guestAccountId: g.id, email: g.email };
  const h = await prisma.host.findUnique({ where: { referralCode: c }, select: { id: true, email: true } });
  if (h) return { code: c, hostId: h.id, email: h.email };
  return null;
}

// A new host signed up with a referral code: record it. Nobody can refer
// themselves (same host, or same email as the guest account).
async function recordReferral(newHost, code) {
  try {
    const owner = await ownerOf(code);
    if (!owner) return null;
    if (owner.hostId === newHost.id || (owner.email && owner.email.toLowerCase() === String(newHost.email || '').toLowerCase())) return null;
    return await prisma.hostReferral.create({
      data: { code: owner.code, referrerGuestAccountId: owner.guestAccountId || null, referrerHostId: owner.hostId || null, referredHostId: newHost.id, amountCents: REFERRAL_CENTS },
    });
  } catch (e) { console.error('[referrals] record failed', e.message); return null; }
}

// Mark referrals earned once the referred host's first paid SimonStays stay is
// over. Cheap enough to run whenever referrals are looked at.
async function refreshEarned(now = new Date()) {
  const open = await prisma.hostReferral.findMany({ where: { status: 'signed_up' } });
  for (const r of open) {
    const b = await prisma.booking.findFirst({
      where: { source: 'website', status: 'confirmed', paid: true, checkOut: { lt: now }, unit: { property: { hostId: r.referredHostId } } },
      orderBy: { checkOut: 'asc' }, select: { id: true },
    });
    if (b) await prisma.hostReferral.update({ where: { id: r.id }, data: { status: 'earned', earnedAt: now, earnedBookingId: b.id } });
  }
}

// A referrer's own list: who they referred and where each stands.
async function referralsOf({ guestAccountId, hostId }) {
  await refreshEarned();
  const rows = await prisma.hostReferral.findMany({ where: guestAccountId ? { referrerGuestAccountId: guestAccountId } : { referrerHostId: hostId }, orderBy: { createdAt: 'desc' } });
  const hosts = rows.length ? await prisma.host.findMany({ where: { id: { in: rows.map((r) => r.referredHostId) } }, select: { id: true, name: true, email: true } }) : [];
  return rows.map((r) => {
    const h = hosts.find((x) => x.id === r.referredHostId);
    return { name: (h && (h.name || h.email.replace(/@.*/, ''))) || 'A host', status: r.status, amountCents: r.amountCents, createdAt: r.createdAt, earnedAt: r.earnedAt, paidAt: r.paidAt };
  });
}

module.exports = { WELCOME_PERCENT, REFERRAL_CENTS, welcomeStatus, welcomeEligible, welcomeForQuote, welcomeCentsOf, applyWelcome, codeFor, ownerOf, recordReferral, refreshEarned, referralsOf, linkFor };
