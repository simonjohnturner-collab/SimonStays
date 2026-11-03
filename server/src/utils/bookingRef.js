// The next human-friendly booking reference, numbered across the whole site. EFT
// guests pay with it, so it must never repeat: counting bookings would reissue a
// number once a booking was deleted, so this carries on from the highest in use.
const prisma = require('../lib/prisma');

async function nextRef() {
  const rows = await prisma.booking.findMany({ where: { ref: { startsWith: 'SS' } }, select: { ref: true } });
  let max = 1000;
  for (const { ref } of rows) {
    const m = /^SS(\d+)(?:-\d+)?$/.exec(ref); // SS1003-2 is the second unit on invoice SS1003
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `SS${max + 1}`;
}

module.exports = { nextRef };
