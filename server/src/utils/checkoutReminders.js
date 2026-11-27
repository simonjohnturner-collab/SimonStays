// Night-before reminders to cleaners (WhatsApp), for checkout AND in-stay cleans.
// Runs daily at 19:00 SAST: takes every clean tomorrow (utils/cleaningJobs) that
// has a cleaner, looks up the cleaner's phone in the ServiceProvider directory and
// WhatsApps one message per clean: the guest, the kind of clean, the place, the
// expected start time and the notes (late checkout, collect the mattress, …).
//
// Template TWILIO_WHATSAPP_CLEANER_CONTENT_SID ("simonstays_cleaner_job"):
//   {{1}} cleaner first name · {{2}} the date · {{3}} kind of clean and place
//   {{4}} start time · {{5}} guest · {{6}} notes, on one line
// Until it's set, a checkout clean falls back to the older checkout template
// (TWILIO_WHATSAPP_CONTENT_SID: {{1}} name · {{2}} place · {{3}} date · {{4}} notes),
// and an in-stay clean goes as plain text (only lands inside WhatsApp's 24-hour window).
//
// Dormant-safe: does nothing unless Twilio WhatsApp creds are set (whatsapp.enabled()).
const prisma = require('../lib/prisma');
const wa = require('./whatsapp');
const jobs = require('./cleaningJobs');

function fmtDate(iso) {
  try { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); }
  catch (e) { return iso; }
}
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }
const oneLine = (s, max) => String(s || '').replace(/\s*\n+\s*/g, ' · ').replace(/[\t ]{2,}/g, ' ').trim().slice(0, max) || '—';

// "tomorrow, Friday 28 November", "today, …" or "Friday 28 November".
function whenOf(iso, now = new Date()) {
  const today = jobs.todaySAST(now);
  const rel = iso === today ? 'today, ' : iso === jobs.addDays(today, 1) ? 'tomorrow, ' : '';
  return rel + fmtDate(iso);
}

// The message for one clean on `iso`.
function buildMessage(job, iso) {
  const lines = [
    `Hi ${firstName(job.cleaner)}, a reminder from SimonStays for ${whenOf(iso)}:`,
    '',
    `🧹 ${job.label}: ${job.place}`,
    `🕙 Start at ${job.time}`,
    `👤 Guest: ${job.guestName || '—'}`,
  ];
  if (job.notes.length) lines.push(`📋 ${job.notes.join(' · ')}`);
  lines.push('', 'Thank you!');
  const body = lines.join('\n');
  const contentVariables = {
    1: firstName(job.cleaner), 2: whenOf(iso), 3: oneLine(`${job.label} at ${job.place}`, 200),
    4: job.time, 5: oneLine(job.guestName, 100), 6: oneLine(job.notes.join(' · '), 700),
  };
  return { body, contentVariables };
}

async function cleanerPhone(hostId, name) {
  if (!hostId || !name) return null;
  const p = await prisma.serviceProvider.findFirst({
    where: { hostId, name: { equals: name.trim(), mode: 'insensitive' } },
    select: { phone: true },
  });
  return p && p.phone ? p.phone : null;
}

// WhatsApp one clean's reminder and mark it sent.
async function remindJob(job, iso, { force = false } = {}) {
  if (!force && job.reminded) return { ok: false, reason: 'already_sent' };
  if (!job.cleaner) return { ok: false, reason: 'no_cleaner' };
  const phone = await cleanerPhone(job.hostId, job.cleaner);
  if (!phone) return { ok: false, reason: 'no_phone', cleaner: job.cleaner };
  const { body, contentVariables } = buildMessage(job, iso);
  const newTemplate = String(process.env.TWILIO_WHATSAPP_CLEANER_CONTENT_SID || '').trim();
  let res;
  if (newTemplate) {
    res = await wa.sendWhatsApp({ to: phone, body, contentSid: newTemplate, contentVariables });
  } else if (job.kind === 'checkout') {
    // The older checkout template: put the start time, guest and notes in its notes slot.
    const notes = oneLine([`Start at ${job.time}`, `Guest: ${job.guestName || '—'}`, ...job.notes].join(' · '), 700);
    res = await wa.sendWhatsApp({ to: phone, body, contentVariables: { 1: firstName(job.cleaner), 2: job.place, 3: fmtDate(iso), 4: notes } });
  } else {
    res = await wa.sendWhatsApp({ to: phone, body, contentSid: null });
  }
  if (res.ok) {
    const at = new Date();
    if (job.kind === 'checkout') await prisma.booking.update({ where: { id: job.bookingId }, data: { checkoutReminderAt: at } }).catch(() => {});
    else await prisma.clean.update({ where: { id: job.cleanId }, data: { reminderAt: at } }).catch(() => {});
  }
  return { ...res, cleaner: job.cleaner, phone };
}

// The manual "Send reminder now" on a booking: its checkout clean.
async function remindForBooking(booking, { force = false } = {}) {
  const found = await jobs.checkoutJobOf(booking.id);
  if (!found) return { ok: false, reason: 'not_found' };
  return remindJob(found.job, found.iso, { force });
}

// The daily 19:00 job: every clean tomorrow.
async function runDaily(now = new Date()) {
  if (!wa.enabled()) return { skipped: 'no_creds' };
  const iso = jobs.addDays(jobs.todaySAST(now), 1);
  const list = await jobs.jobsForDay(iso);
  const out = { date: iso, total: list.length, sent: 0, skipped: [] };
  for (const job of list) {
    const r = await remindJob(job, iso);
    if (r.ok) out.sent++;
    else out.skipped.push({ key: job.key, place: job.place, cleaner: job.cleaner, reason: r.reason || r.error });
  }
  return out;
}

module.exports = { runDaily, remindForBooking, remindJob, enabled: wa.enabled, buildMessage };
