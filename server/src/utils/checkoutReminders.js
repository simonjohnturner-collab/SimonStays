// Night-before reminders to cleaners (WhatsApp), for checkout AND in-stay cleans.
// Runs daily at 19:00 SAST: takes every clean tomorrow (utils/cleaningJobs) that
// has a cleaner, looks up the cleaner's phone in the ServiceProvider directory and
// WhatsApps one message per clean: the guest, the kind of clean, the place, the
// expected start time and the notes (late checkout, collect the mattress, …).
//
// Template TWILIO_WHATSAPP_CLEANER_CONTENT_SID ("simonstays_cleaner_job_link", call to action):
//   {{1}} cleaner first name · {{2}} the date · {{3}} kind of clean and place
//   {{4}} start time · {{5}} guest · {{6}} notes, on one line
//   button "Open my clean report" → https://simonstays.co.za/team/job/{{7}}
// Every message carries the cleaner's link to the report for that clean, which
// opens with "I've arrived". 15 minutes after the start with no arrival the
// cleaner is asked if all is well (TWILIO_WHATSAPP_CLEANER_LATE_CONTENT_SID,
// "simonstays_cleaner_late"); at 30 minutes the host is told.
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
function buildMessage(job, iso, now = new Date()) {
  const lines = [
    `Hi ${firstName(job.cleaner)}, a reminder from SimonStays for ${whenOf(iso, now)}:`,
    '',
    `🧹 ${job.label}: ${job.place}`,
    `🕙 Start at ${job.time}`,
    `👤 Guest: ${job.guestName || '—'}`,
  ];
  if (job.notes.length) lines.push(`📋 ${job.notes.join(' · ')}`);
  if (job.dayCount > 1) lines.push(`🔢 Clean ${job.seq} of ${job.dayCount}${job.seq === 1 ? ': start with this one' : ''}`);
  lines.push('', `When you arrive, open your clean report and tap "I've arrived": ${jobs.jobLink(job.key)}`, '', 'Thank you!');
  const body = lines.join('\n');
  const contentVariables = {
    1: firstName(job.cleaner), 2: whenOf(iso, now), 3: oneLine(`${job.label} at ${job.place}`, 200),
    4: job.time, 5: oneLine(job.guestName, 100),
    6: oneLine([...(job.dayCount > 1 ? [`Clean ${job.seq} of ${job.dayCount}${job.seq === 1 ? ': start with this one' : ''}`] : []), ...job.notes].join(' · '), 700),
    7: jobs.jobToken(job.key),
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
async function remindJob(job, iso, { force = false, now = new Date() } = {}) {
  if (!force && job.reminded) return { ok: false, reason: 'already_sent' };
  if (!job.cleaner) return { ok: false, reason: 'no_cleaner' };
  const phone = await cleanerPhone(job.hostId, job.cleaner);
  if (!phone) return { ok: false, reason: 'no_phone', cleaner: job.cleaner };
  const { body, contentVariables } = buildMessage(job, iso, now);
  const newTemplate = String(process.env.TWILIO_WHATSAPP_CLEANER_CONTENT_SID || '').trim();
  let res;
  if (newTemplate) {
    res = await wa.sendWhatsApp({ to: phone, body, contentSid: newTemplate, contentVariables });
  } else if (job.kind === 'checkout') {
    // The older checkout template: put the start time, guest and notes in its notes slot.
    const notes = oneLine([`Start at ${job.time}`, `Guest: ${job.guestName || '—'}`, ...job.notes, `When you arrive, open your report: ${jobs.jobLink(job.key)}`].join(' · '), 900);
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

// ---- What each cleaner was told, to spot overnight changes ----
const cleanerKey = (name) => String(name || '').trim().toLowerCase();
const snap = (j) => ({ key: j.key, kind: j.kind, label: j.label, place: j.place, time: j.time, guestName: j.guestName || null, notes: j.notes });
// Group a day's jobs by host + cleaner.
function byCleaner(list) {
  const m = new Map();
  list.filter((j) => j.cleaner && j.hostId).forEach((j) => {
    const k = `${j.hostId}|${cleanerKey(j.cleaner)}`;
    if (!m.has(k)) m.set(k, { hostId: j.hostId, cleaner: j.cleaner, jobs: [] });
    m.get(k).jobs.push(j);
  });
  return m;
}
async function saveNotice(hostId, date, cleaner, kind, list) {
  const data = { hostId, date, cleaner: cleanerKey(cleaner), kind, jobs: list.map(snap) };
  await prisma.cleanerNotice.upsert({
    where: { hostId_date_cleaner_kind: { hostId, date, cleaner: data.cleaner, kind } },
    create: data, update: { jobs: data.jobs, sentAt: new Date() },
  });
}

// The daily 19:00 job: every clean tomorrow. Records what each cleaner was told.
async function runDaily(now = new Date()) {
  if (!wa.enabled()) return { skipped: 'no_creds' };
  const iso = jobs.addDays(jobs.todaySAST(now), 1);
  const list = await jobs.jobsForDay(iso);
  const out = { date: iso, total: list.length, sent: 0, skipped: [] };
  for (const job of list) {
    const r = await remindJob(job, iso, { now });
    if (r.ok) out.sent++;
    else out.skipped.push({ key: job.key, place: job.place, cleaner: job.cleaner, reason: r.reason || r.error });
  }
  for (const g of byCleaner(list).values()) {
    if (await cleanerPhone(g.hostId, g.cleaner)) await saveNotice(g.hostId, iso, g.cleaner, 'evening', g.jobs).catch((e) => console.error('[cleaner-notice] save failed', e.message));
  }
  return out;
}

// What changed for one cleaner between what they were told and now. Lines, or [].
function changesFor(before, after) {
  const lines = [];
  const was = new Map(before.map((j) => [j.key, j]));
  const now = new Map(after.map((j) => [j.key, j]));
  for (const j of after) {
    const b = was.get(j.key);
    if (!b) { lines.push(`➕ Added: ${j.label} at ${j.place}, start ${j.time}`); continue; }
    if (b.place !== j.place) lines.push(`🏠 Moved: ${j.label} is now at ${j.place} (was ${b.place})`);
    if (b.time !== j.time) lines.push(`🕙 ${j.place}: now starts at ${j.time} (was ${b.time})`);
    if ((b.guestName || '') !== (j.guestName || '')) lines.push(`👤 ${j.place}: guest is now ${j.guestName || '—'}`);
    const added = (j.notes || []).filter((n) => !(b.notes || []).includes(n));
    if (added.length) lines.push(`📋 ${j.place}: ${added.join(' · ')}`);
  }
  for (const b of before) if (!now.has(b.key)) lines.push(`❌ Cancelled: ${b.label} at ${b.place}`);
  return lines;
}

function changeMessage(cleaner, iso, lines, after, hostId) {
  const today = after.length
    ? after.slice().sort((a, b) => a.time.localeCompare(b.time)).map((j) => `${j.time} ${j.place} (${j.label.toLowerCase()})`)
    : ['No cleans for you today.'];
  const body = [
    `Hi ${firstName(cleaner)}, there are changes to your cleans today, ${fmtDate(iso)}:`, '',
    ...lines, '',
    'Your cleans today:', ...today, '',
    `Open your cleans: ${jobs.dayLink(hostId, cleaner, iso)}`, '',
    'Thank you!',
  ].join('\n');
  return { body, contentVariables: { 1: firstName(cleaner), 2: fmtDate(iso), 3: oneLine(lines.join(' · '), 900), 4: oneLine(today.join(' · '), 600), 5: jobs.dayToken(hostId, cleaner, iso) } };
}

// The daily 06:30 job: tell each cleaner what changed overnight, and only if
// something did. A cleaner allocated after 19:00 gets their cleans as "added".
async function runMorning(now = new Date()) {
  if (!wa.enabled()) return { skipped: 'no_creds' };
  const iso = jobs.todaySAST(now);
  const current = byCleaner(await jobs.jobsForDay(iso));
  const notices = await prisma.cleanerNotice.findMany({ where: { date: iso } });
  const told = new Map(notices.filter((n) => n.kind === 'evening').map((n) => [`${n.hostId}|${n.cleaner}`, n]));
  const sentToday = new Set(notices.filter((n) => n.kind === 'morning').map((n) => `${n.hostId}|${n.cleaner}`));
  const keys = new Set([...current.keys(), ...told.keys()]);
  const out = { date: iso, sent: 0, unchanged: 0, skipped: [] };
  const template = String(process.env.TWILIO_WHATSAPP_CLEANER_CHANGE_CONTENT_SID || '').trim() || null;
  for (const k of keys) {
    if (sentToday.has(k)) continue;
    const g = current.get(k);
    const ev = told.get(k);
    const hostId = g ? g.hostId : ev.hostId;
    const name = g ? g.cleaner : ev.cleaner;
    const after = g ? g.jobs : [];
    const lines = changesFor(ev ? ev.jobs : [], after);
    if (!lines.length) { out.unchanged++; continue; }
    const phone = await cleanerPhone(hostId, name);
    if (!phone) { out.skipped.push({ cleaner: name, reason: 'no_phone' }); continue; }
    const { body, contentVariables } = changeMessage(name, iso, lines, after, hostId);
    const r = await wa.sendWhatsApp({ to: phone, body, contentSid: template, contentVariables });
    if (r.ok) { out.sent++; await saveNotice(hostId, iso, name, 'morning', after).catch(() => {}); }
    else out.skipped.push({ cleaner: name, reason: r.error || r.skipped });
  }
  return out;
}

// ---- Late: no "I've arrived" by 15 minutes after the start → ask the cleaner; by 30 → tell the host ----
const NUDGE_MIN = 15, ALERT_MIN = 30;
const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
async function runLateChecks(now = new Date()) {
  if (!wa.enabled()) return { skipped: 'no_creds' };
  const iso = jobs.todaySAST(now);
  const sast = new Date(now.getTime() + 2 * 3600e3);
  const nowMin = sast.getUTCHours() * 60 + sast.getUTCMinutes();
  // Only cleaners who were sent their link (told at 19:00 or 06:30): nobody is
  // chased for a check-in they never knew about.
  const told = new Set((await prisma.cleanerNotice.findMany({ where: { date: iso }, select: { hostId: true, cleaner: true } })).map((n) => `${n.hostId}|${n.cleaner}`));
  const list = (await jobs.jobsForDay(iso)).filter((j) => j.cleaner && !j.arrivedAt && told.has(`${j.hostId}|${cleanerKey(j.cleaner)}`));
  const out = { date: iso, nudged: 0, alerted: 0 };
  for (const j of list) {
    const late = nowMin - minutesOf(j.time);
    if (late >= NUDGE_MIN && !j.nudgedAt) {
      const phone = await cleanerPhone(j.hostId, j.cleaner);
      if (phone) {
        const body = `Hi ${firstName(j.cleaner)}, your ${j.label.toLowerCase()} at ${j.place} was due to start at ${j.time}, and you haven't told us you're on site yet. Is everything okay?\n\nWhen you arrive, tap "I've arrived" here: ${jobs.jobLink(j.key)}`;
        const template = String(process.env.TWILIO_WHATSAPP_CLEANER_LATE_CONTENT_SID || '').trim() || null;
        const r = await wa.sendWhatsApp({ to: phone, body, contentSid: template, contentVariables: { 1: firstName(j.cleaner), 2: oneLine(`${j.label.toLowerCase()} at ${j.place}`, 200), 3: j.time, 4: jobs.jobToken(j.key) } });
        if (r.ok) out.nudged++;
      }
      await prisma.cleanArrival.upsert({ where: { jobKey: j.key }, create: { jobKey: j.key, hostId: j.hostId, date: iso, cleaner: j.cleaner, nudgedAt: now }, update: { nudgedAt: now } });
    }
    if (late >= ALERT_MIN && !j.alertedAt) {
      const phone = await cleanerPhone(j.hostId, j.cleaner);
      await require('./payments').alertHost({ hostId: j.hostId },
        `⏰ ${j.cleaner} hasn't arrived at ${j.place}\n${j.label} was due to start at ${j.time}, and there's no check-in 30 minutes later.${phone ? ` Their number: ${phone}` : ''}`);
      await prisma.cleanArrival.upsert({ where: { jobKey: j.key }, create: { jobKey: j.key, hostId: j.hostId, date: iso, cleaner: j.cleaner, alertedAt: now }, update: { alertedAt: now } });
      out.alerted++;
    }
  }
  return out;
}

module.exports = { runLateChecks, runDaily, runMorning, changesFor, remindForBooking, remindJob, enabled: wa.enabled, buildMessage };
