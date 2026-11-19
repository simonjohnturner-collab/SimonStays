// Growth: the 5% welcome discount for fully signed-up guests, and the R1 000
// reward for referring a new host.
//
// Welcome discount: 5% off the stay (not the breakage deposit) on a guest's
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

// Can this guest have the welcome discount? Their account is complete and they
// haven't had a SimonStays booking yet (or one already holding the discount).
async function welcomeEligible(guestAccountId) {
  if (!guestAccountId) return false;
  const acct = await prisma.guestAccount.findUnique({ where: { id: guestAccountId }, include: { documents: { select: { kind: true } } } });
  if (!acct || !acct.emailVerifiedAt) return false;
  const kinds = new Set(acct.documents.map((d) => d.kind));
  if (!kinds.has('photo') || !kinds.has('id')) return false;
  const earlier = await prisma.booking.count({
    where: {
      source: 'website',
      OR: [{ guestAccountId: acct.id }, { guestEmail: { equals: acct.email, mode: 'insensitive' } }],
      AND: [{ OR: [{ status: 'confirmed' }, { status: 'pending', welcomeDiscountCents: { gt: 0 } }] }],
    },
  });
  return earlier === 0;
}

// Take the welcome discount off a shopfront quote (in place). The deposit isn't discounted.
function applyWelcome(q) {
  if (!q) return q;
  const cents = Math.round(q.rentalCents * WELCOME_PERCENT / 100);
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

module.exports = { WELCOME_PERCENT, REFERRAL_CENTS, welcomeEligible, applyWelcome, codeFor, ownerOf, recordReferral, refreshEarned, referralsOf, linkFor };
