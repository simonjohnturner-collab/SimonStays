/**
 * One-shot competitor market probe — seed a competitor and/or run a live probe.
 *
 * Examples:
 *   node scripts/probe-market.js --seed                 # create the CAG/Vantage competitor
 *   node scripts/probe-market.js --dry --days=14        # probe live, print, DON'T write
 *   node scripts/probe-market.js --days=30              # probe live and store snapshots
 *   node scripts/probe-market.js --host=you@example.com # target a specific host account
 *
 * --dry is the quickest way to verify the engine still answers and the fields are
 * right: it hits the live API and prints availability + price WITHOUT touching the
 * database or needing a host account. Everything else (seed / persist) needs a host.
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const marketProbe = require('../src/utils/marketProbe');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};

const HOST_EMAIL = (val('host', process.env.ADMIN_EMAIL) || 'simonjohnturner@outlook.com').toLowerCase();
const DAYS = Number(val('days', String(marketProbe.config().windowDays)));
const DRY = has('--dry');
const SEED = has('--seed');

// The CAG "The Vantage" competitor, discovered from tcagroup.co.za ->
// direct-book.com/properties/TheVantageDirect (SiteMinder "The Booking Button").
const CAG_VANTAGE = {
  name: 'CAG — The Vantage',
  building: 'The Vantage, Rosebank',
  source: 'SITEMINDER_TBB',
  channelCode: 'TheVantageDirect',
  currency: 'ZAR',
  notes: 'Corporate Apartment Group. ~51 units across 7 room types. Seeded from direct-book.com.',
};

async function seedCompetitor(host) {
  const existing = await prisma.competitor.findFirst({
    where: { hostId: host.id, channelCode: CAG_VANTAGE.channelCode },
  });
  if (existing) {
    console.log(`Competitor already exists: ${existing.name} (${existing.id})`);
    return existing;
  }
  const c = await prisma.competitor.create({ data: { hostId: host.id, ...CAG_VANTAGE } });
  console.log(`Seeded competitor: ${c.name} (${c.id})`);
  return c;
}

async function resolveCompetitor() {
  // Dry mode is a pure live-API check — no DB, no host needed. Probe the CAG
  // constant directly (channel overridable via --channel=).
  if (DRY && !SEED) {
    return { id: 'dry', ...CAG_VANTAGE, channelCode: val('channel', CAG_VANTAGE.channelCode), active: true };
  }
  const host = await prisma.host.findFirst({ where: { email: HOST_EMAIL } });
  if (!host) {
    console.error(`No host found for "${HOST_EMAIL}". Pass --host=<your account email>.`);
    console.error('(Or just verify the live signal with:  node scripts/probe-market.js --dry --days=14)');
    process.exit(1);
  }
  if (SEED) return seedCompetitor(host);
  const competitor = await prisma.competitor.findFirst({
    where: { hostId: host.id, source: 'SITEMINDER_TBB', active: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!competitor) {
    console.error('No SiteMinder-TBB competitor found. Run once with --seed first.');
    process.exit(1);
  }
  return competitor;
}

(async () => {
  const competitor = await resolveCompetitor();

  console.log(`\nProbing "${competitor.name}" (${competitor.channelCode}) — ${DAYS} night(s)${DRY ? ' [DRY: no DB writes]' : ''}\n`);
  const summary = await marketProbe.probeCompetitor(competitor, { days: DAYS, write: !DRY });

  // Print a compact per-night grid.
  const byDate = new Map();
  for (const r of summary.rowsOut || []) {
    if (!byDate.has(r.stayDate)) byDate.set(r.stayDate, []);
    byDate.get(r.stayDate).push(r);
  }
  for (const [date, rows] of byDate) {
    const avail = rows.filter((r) => r.available).length;
    const prices = rows.filter((r) => r.price != null).map((r) => Number(r.price));
    const lo = prices.length ? Math.min(...prices) : null;
    const hi = prices.length ? Math.max(...prices) : null;
    const priceStr = prices.length ? `R${lo}–R${hi}` : 'no price';
    console.log(`${date}  ${String(avail).padStart(2)}/${rows.length} room types bookable   ${priceStr}`);
  }
  console.log(`\nSummary: ${summary.nights} night(s), ${summary.rows} row(s), ${summary.available} available, ${summary.errors} error(s)${DRY ? ' (nothing written)' : ''}`);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
