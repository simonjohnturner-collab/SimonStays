// Every clean on a day, for the Cleaners tab and the night-before WhatsApp:
// checkout cleans (the day a confirmed booking checks out) and in-stay cleans
// (a Clean booked for a date during the stay). Each job carries the cleaner, the
// guest, what kind of clean it is, the expected start time and the notes.
//
// Start time: 10:00, or 13:30 after a late checkout (guests are told late
// checkout is by 13:30), unless the checkout notes give a time ("start 11:30",
// "12h00", "11am"), which wins.
const prisma = require('../lib/prisma');
const { shownCheckOut } = require('./ical');

const DAY_MS = 864e5;
const SAST_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TIME = '10:00';
const LATE_TIME = '13:30';

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
// Today in South Africa, as YYYY-MM-DD.
const todaySAST = (now = new Date()) => isoDay(now.getTime() + SAST_MS);
const addDays = (iso, n) => isoDay(Date.parse(iso + 'T12:00:00Z') + n * DAY_MS);
// Dates are stored at noon UTC, so a day is its UTC calendar day.
const rangeOf = (iso) => { const s = Date.parse(iso + 'T00:00:00Z'); return { gte: new Date(s), lt: new Date(s + DAY_MS) }; };

// The first clock time written in the notes, as HH:MM, or null.
function timeInNotes(text) {
  const s = String(text || '');
  let m = /\b([01]?\d|2[0-3])\s*[:h]\s*([0-5]\d)\s*(am|pm)?\b/i.exec(s);
  let h, min;
  if (m) { h = Number(m[1]); min = Number(m[2]); }
  else {
    m = /\b(1[0-2]|0?[1-9])\s*(am|pm)\b/i.exec(s);
    if (!m) return null;
    h = Number(m[1]); min = 0;
  }
  const ap = (m[3] || m[2] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const placeOf = (b) => [b.unit?.property?.name, b.unit?.name && `Unit ${b.unit.name}`].filter(Boolean).join(' · ') || 'the unit';
const hostIdOf = (b) => b.hostId || b.unit?.property?.hostId || null;
const ownedBy = (hostId) => ({ OR: [{ hostId }, { unit: { property: { hostId } } }] });
const UNIT = { unit: { include: { property: { select: { name: true, hostId: true } } } } };

function checkoutJob(b, arrivals) {
  const fromNotes = timeInNotes(b.checkoutNotes);
  const time = fromNotes || (b.lateCheckOut ? LATE_TIME : DEFAULT_TIME);
  const notes = [];
  if (b.lateCheckOut) notes.push(`Late checkout: the guest leaves by ${LATE_TIME}`);
  if (b.extraMattress) notes.push('Collect the extra mattress');
  if (arrivals.has(b.unitId)) notes.push('A new guest checks in today');
  if (b.checkoutNotes && b.checkoutNotes.trim()) notes.push(b.checkoutNotes.trim());
  return {
    key: `co-${b.id}`, kind: 'checkout', label: 'Checkout clean',
    bookingId: b.id, cleanId: null, hostId: hostIdOf(b), unitId: b.unitId,
    place: placeOf(b), guestName: b.guestName || null, ref: b.ref || null,
    cleaner: b.cleaner || null, time, timeFrom: fromNotes ? 'notes' : b.lateCheckOut ? 'late' : 'default',
    notes, reminded: !!b.checkoutReminderAt,
  };
}

function instayJob(c) {
  const b = c.booking;
  const notes = ['The guest is staying: clean around them'];
  if (c.paymentMethod === 'direct') notes.push('The guest pays you for this clean');
  return {
    key: `in-${c.id}`, kind: 'instay', label: 'In-stay clean',
    bookingId: b.id, cleanId: c.id, hostId: hostIdOf(b), unitId: b.unitId,
    place: placeOf(b), guestName: b.guestName || null, ref: b.ref || null,
    cleaner: c.cleaner || null, time: DEFAULT_TIME, timeFrom: 'default',
    notes, reminded: !!c.reminderAt,
  };
}

// All cleans on `iso` (YYYY-MM-DD), for one host or (hostId null) everyone.
async function jobsForDay(iso, { hostId = null } = {}) {
  const day = rangeOf(iso);
  const mine = hostId ? [ownedBy(hostId)] : [];
  const [leaving, dayUse, arriving, cleans] = await Promise.all([
    prisma.booking.findMany({ where: { AND: [...mine, { status: 'confirmed', dayUse: false, checkOut: day, unitId: { not: null } }] }, include: UNIT }),
    prisma.booking.findMany({ where: { AND: [...mine, { status: 'confirmed', dayUse: true, checkIn: day, unitId: { not: null } }] }, include: UNIT }),
    prisma.booking.findMany({ where: { AND: [...mine, { status: 'confirmed', checkIn: day, unitId: { not: null } }] }, select: { id: true, unitId: true } }),
    prisma.clean.findMany({ where: { date: day, booking: { AND: [...mine, { status: 'confirmed' }] } }, include: { booking: { include: UNIT } } }),
  ]);
  const out = [...leaving, ...dayUse];
  const jobs = out.map((b) => checkoutJob(b, new Set(arriving.filter((a) => a.id !== b.id).map((a) => a.unitId))))
    .concat(cleans.map(instayJob));
  return jobs.sort((a, b) => a.time.localeCompare(b.time) || a.place.localeCompare(b.place));
}

// The checkout clean for one booking (its own checkout day).
async function checkoutJobOf(bookingId) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: UNIT });
  if (!b || !b.unitId) return null;
  const iso = isoDay(shownCheckOut(b));
  const arriving = await prisma.booking.findMany({ where: { status: 'confirmed', checkIn: rangeOf(iso), unitId: b.unitId, id: { not: b.id } }, select: { unitId: true } });
  return { iso, job: checkoutJob(b, new Set(arriving.map((a) => a.unitId))) };
}

module.exports = { jobsForDay, checkoutJobOf, timeInNotes, todaySAST, addDays, DEFAULT_TIME, LATE_TIME };
