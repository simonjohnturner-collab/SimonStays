require('dotenv').config();
const prisma = require('../src/lib/prisma');

(async () => {
  const hosts = await prisma.host.findMany({ select: { id: true, email: true } });
  for (const h of hosts) {
    console.log(`\n=== HOST ${h.email} ===`);
    const props = await prisma.property.findMany({
      where: { hostId: h.id },
      include: { units: { include: { channels: true, _count: { select: { bookings: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    for (const p of props) {
      console.log(`  Property: ${p.name}`);
      for (const u of p.units) {
        console.log(`    Unit ${u.name}  (bookings: ${u._count.bookings})`);
        for (const c of u.channels) {
          console.log(`       channel[${c.type}] status="${c.lastStatus || 'never'}" lastSynced=${c.lastSyncedAt || '-'}`);
          console.log(`         importUrl: ${c.importUrl}`);
        }
      }
    }
  }
  const recentLogs = await prisma.syncLog.findMany({ orderBy: { ranAt: 'desc' }, take: 8 });
  console.log('\n=== RECENT SYNC LOGS ===');
  recentLogs.forEach((l) => console.log(`  ${l.ranAt.toISOString()} ${l.channelType} ok=${l.ok} +${l.added} ~${l.updated} -${l.removed} ${l.message || ''}`));
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
