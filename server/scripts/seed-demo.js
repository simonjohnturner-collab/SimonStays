/**
 * Seed a demo host with a populated board so the UI shows real content on first
 * open. Idempotent: wipes and re-creates the demo host each run.
 *   Login:  demo@staysync.local  /  password123
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { dateOnly } = require('../src/utils/ical');

const EMAIL = 'demo@staysync.local';

function d(days) {
  const t = new Date();
  const base = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate(), 12));
  base.setUTCDate(base.getUTCDate() + days);
  return dateOnly(base);
}

(async () => {
  await prisma.host.deleteMany({ where: { email: EMAIL } }); // cascades to all data
  const host = await prisma.host.create({
    data: { email: EMAIL, passwordHash: await bcrypt.hash('password123', 10), name: 'Demo Host' },
  });

  const firenza = await prisma.property.create({ data: { hostId: host.id, name: 'Firenza', address: 'Sandton' } });
  const vantage = await prisma.property.create({ data: { hostId: host.id, name: 'Vantage', address: 'Rosebank' } });

  const mk = (propertyId, name) => prisma.unit.create({ data: { propertyId, name } });
  const f23 = await mk(firenza.id, '23');
  const f31 = await mk(firenza.id, '31');
  const f36 = await mk(firenza.id, '36');
  const v202 = await mk(vantage.id, '202');
  const v304 = await mk(vantage.id, '304');

  const B = (unitId, guestName, from, to, extra = {}) => prisma.booking.create({
    data: { unitId, source: 'manual', status: 'confirmed', guestName, checkIn: d(from), checkOut: d(to), paid: true, ...extra },
  });

  await B(f23.id, 'Kevin', 1, 6, { cleaner: 'Grace' });
  await B(f23.id, 'Norena', 6, 12);
  await B(f31.id, 'Christian', 0, 9, { source: 'airbnb', channelType: 'airbnb', comments: 'ResCode: HMABC12345' });
  await B(f36.id, 'Thabo', 2, 5, { paid: false, comments: 'AWAITING PAYMENT' }); // red
  await B(v202.id, 'Khurl', 1, 7, { cleaner: 'Precious' });
  await B(v304.id, 'Lean', 1, 4, { leavingEarly: true });
  await B(v304.id, 'Hendrik', 4, 8, { comments: 'extra mattress' });

  console.log(`Seeded demo host ${EMAIL} / password123`);
  console.log('Properties: Firenza (23,31,36), Vantage (202,304); bookings incl. an unpaid (red) + checkout days (blue).');
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
