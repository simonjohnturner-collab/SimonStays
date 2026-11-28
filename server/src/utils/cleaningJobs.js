// Every clean on a day, for the Cleaners tab and the night-before WhatsApp:
// checkout cleans (the day a confirmed booking checks out) and in-stay cleans
// (a Clean booked for a date during the stay). Each job carries the cleaner, the
// guest, what kind of clean it is, the expected start time and the notes.
//
// Start time: 10:00, or 13:30 after a late checkout (guests are told late
// checkout is by 13:30), unless the checkout notes give a time ("start 11:30",
// "12h00", "11am"), which wins.
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { shownCheckOut } = require('./ical');

// ---- Private links for cleaners (no sign-in): one per clean, one per cleaner's day ----
const SITE = () => (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
const mac = (s, purpose) => crypto.createHmac('sha256', `${purpose}:${process.env.JWT_SECRET || 'dev-secret'}`).update(s).digest('base64url').slice(0, 22);
const jobToken = (key) => `${key}.${mac(key, 'cleaner-job')}`;
const jobLink = (key) => `${SITE()}/team/job/${jobToken(key)}`;
function keyFromJobToken(token) {
  const t = String(token || '');
  const i = t.lastIndexOf('.');
  if (i < 1) return null;
  const key = t.slice(0, i), given = t.slice(i + 1);
  const want = mac(key, 'cleaner-job');
  return given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want)) ? key : null;
}
const dayPayload = (hostId, cleaner, date) => `${hostId}~${date}~${Buffer.from(String(cleaner || '').trim().toLowerCase()).toString('base64url')}`;
const dayToken = (hostId, cleaner, date) => { const p = dayPayload(hostId, cleaner, date); return `${p}.${mac(p, 'cleaner-day')}`; };
const dayLink = (hostId, cleaner, date) => `${SITE()}/team/day/${dayToken(hostId, cleaner, date)}`;
function fromDayToken(token) {
  const t = String(token || '');
  const i = t.lastIndexOf('.');
  if (i < 1) return null;
  const p = t.slice(0, i), given = t.slice(i + 1), want = mac(p, 'cleaner-day');
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return null;
  const [hostId, date, c] = p.split('~');
  return { hostId, date, cleaner: Buffer.from(c || '', 'base64url').toString() };
}

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
const UNIT = { unit: { include: { property: { select: { name: true, hostId: true, checkInTime: true } } } } };
const checkInOf = (b) => (b.unit && (b.unit.checkInTime || (b.unit.property && b.unit.property.checkInTime))) || '15:00';

function checkoutJob(b, arrivals) {
  const fromNotes = timeInNotes(b.checkoutNotes);
  const time = fromNotes || (b.lateCheckOut ? LATE_TIME : DEFAULT_TIME);
  const notes = [];
  if (b.lateCheckOut) notes.push(`Late checkout: the guest leaves by ${LATE_TIME}`);
  if (b.extraMattress) notes.push('Collect the extra mattress');
  const arrivalToday = arrivals.has(b.unitId);
  if (arrivalToday) notes.push(`⚡ Do this clean first: a new guest checks in from ${checkInOf(b)}`);
  if (b.checkoutNotes && b.checkoutNotes.trim()) notes.push(b.checkoutNotes.trim());
  return {
    key: `co-${b.id}`, kind: 'checkout', label: 'Checkout clean', date: isoDay(shownCheckOut(b)),
    bookingId: b.id, cleanId: null, hostId: hostIdOf(b), unitId: b.unitId, propertyId: b.unit?.propertyId || null,
    place: placeOf(b), guestName: b.guestName || null, ref: b.ref || null,
    cleaner: b.cleaner || null, time, timeFrom: fromNotes ? 'notes' : b.lateCheckOut ? 'late' : 'default',
    notes, reminded: !!b.checkoutReminderAt, arrivalToday,
  };
}

function instayJob(c) {
  const b = c.booking;
  const notes = ['The guest is staying: clean around them'];
  if (c.paymentMethod === 'direct') notes.push('The guest pays you for this clean');
  // Keyed by booking + date, not the clean's id: editing a booking re-creates its
  // cleans, and the cleaner's link and what they were told must survive that.
  return {
    key: `in-${b.id}-${isoDay(c.date)}`, kind: 'instay', label: 'In-stay clean', date: isoDay(c.date),
    bookingId: b.id, cleanId: c.id, hostId: hostIdOf(b), unitId: b.unitId, propertyId: b.unit?.propertyId || null,
    place: placeOf(b), guestName: b.guestName || null, ref: b.ref || null,
    cleaner: c.cleaner || null, time: DEFAULT_TIME, timeFrom: 'default',
    notes, reminded: !!c.reminderAt, arrivalToday: false,
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
  // Arrival and late-nudge state, and each clean's private link.
  const seen = jobs.length ? await prisma.cleanArrival.findMany({ where: { jobKey: { in: jobs.map((j) => j.key) } } }) : [];
  for (const j of jobs) {
    const a = seen.find((x) => x.jobKey === j.key);
    j.arrivedAt = a ? a.arrivedAt : null;
    j.nudgedAt = a ? a.nudgedAt : null;
    j.alertedAt = a ? a.alertedAt : null;
    j.condition = a ? a.condition || null : null;
    j.link = jobLink(j.key);
  }
  // Which cleans already have their report in.
  const keys = jobs.map((j) => j.key);
  const sent = keys.length ? await prisma.formSubmission.findMany({
    where: { type: 'clean', status: { not: 'incomplete' }, OR: keys.map((k) => ({ answers: { path: ['_job'], equals: k } })) },
    select: { answers: true },
  }) : [];
  const done = new Set(sent.map((s) => s.answers && s.answers._job));
  jobs.forEach((j) => { j.reportDone = done.has(j.key); });
  // The order: by start time, and among cleans starting at the same time, a unit
  // with a guest arriving today first (that's the pressure point). A late-checkout
  // unit can't jump ahead: the cleaner can't get in before its start time.
  jobs.sort(byPriority);
  // Each cleaner's clean N of M for the day.
  const per = {};
  jobs.forEach((j) => {
    if (!j.cleaner) { j.seq = null; j.dayCount = null; return; }
    const k = `${j.hostId}|${String(j.cleaner).trim().toLowerCase()}`;
    j.seq = (per[k] = (per[k] || 0) + 1);
  });
  jobs.forEach((j) => { if (j.cleaner) j.dayCount = per[`${j.hostId}|${String(j.cleaner).trim().toLowerCase()}`]; });
  return jobs;
}
function byPriority(a, b) {
  return a.time.localeCompare(b.time) || (b.arrivalToday ? 1 : 0) - (a.arrivalToday ? 1 : 0) || a.place.localeCompare(b.place);
}

// A cleaner's cleans on the day of `job`, in order (for the tabs and the helper).
async function dayOf(job) {
  if (!job.cleaner) return [job];
  const who = String(job.cleaner).trim().toLowerCase();
  return (await jobsForDay(job.date, { hostId: job.hostId })).filter((j) => String(j.cleaner || '').trim().toLowerCase() === who);
}

// One clean by its key (from a cleaner's link), with its day.
async function jobByKey(key) {
  let iso = null;
  const m = /^in-(.{36})-(\d{4}-\d{2}-\d{2})$/.exec(key || '');
  if (m) iso = m[2];
  else if (/^co-.{36}$/.test(key || '')) {
    const b = await prisma.booking.findUnique({ where: { id: key.slice(3) } });
    if (b) iso = isoDay(shownCheckOut(b));
  }
  if (!iso) return null;
  const job = (await jobsForDay(iso)).find((j) => j.key === key);
  return job ? { iso, job } : null;
}

// The cleaner has arrived (from their link). Returns the arrival time.
async function markArrived(job) {
  const now = new Date();
  const row = await prisma.cleanArrival.upsert({
    where: { jobKey: job.key },
    create: { jobKey: job.key, hostId: job.hostId, date: job.date, cleaner: job.cleaner, arrivedAt: now },
    update: { arrivedAt: now, cleaner: job.cleaner },
  });
  return row.arrivedAt;
}

// The checkout clean for one booking (its own checkout day).
async function checkoutJobOf(bookingId) {
  const found = await jobByKey(`co-${bookingId}`);
  if (found) return found;
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: UNIT });
  if (!b || !b.unitId) return null;
  const iso = isoDay(shownCheckOut(b));
  const arriving = await prisma.booking.findMany({ where: { status: 'confirmed', checkIn: rangeOf(iso), unitId: b.unitId, id: { not: b.id } }, select: { unitId: true } });
  return { iso, job: checkoutJob(b, new Set(arriving.map((a) => a.unitId))) };
}

module.exports = { jobsForDay, dayOf, checkoutJobOf, jobByKey, markArrived, jobLink, jobToken, keyFromJobToken, dayLink, dayToken, fromDayToken, timeInNotes, todaySAST, addDays, DEFAULT_TIME, LATE_TIME };
