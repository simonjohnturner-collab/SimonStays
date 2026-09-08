const prisma = require('../lib/prisma');
const { dateOnly } = require('./ical');

// { 'YYYY-MM-DD': priceCents } of any manual per-night overrides for this unit
// across the given stay (nights are checkIn .. checkOut-1).
async function overridesFor(unitId, checkInISO, checkOutISO) {
  const rows = await prisma.nightPrice.findMany({
    where: { unitId, date: { gte: dateOnly(checkInISO), lt: dateOnly(checkOutISO) } },
  });
  const map = {};
  rows.forEach((r) => { map[r.date.toISOString().slice(0, 10)] = r.priceCents; });
  return map;
}

module.exports = { overridesFor };
