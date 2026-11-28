// A cleaner's private links, from their WhatsApp (no sign-in; the link is the key):
//   /public/cleaning/job/:token       one clean: where, when, guest, notes, arrival
//   /public/cleaning/job/:token/arrive "I've arrived"
//   /public/cleaning/day/:token       all of a cleaner's cleans on a day
const express = require('express');
const jobs = require('../utils/cleaningJobs');

const router = express.Router();
const invalid = (res) => res.status(404).json({ error: 'not_found', message: 'This link isn’t valid any more. Ask SimonStays for a new one.' });
const view = (j) => ({
  key: j.key, kind: j.kind, label: j.label, date: j.date, place: j.place, time: j.time,
  guestName: j.guestName, notes: j.notes, cleaner: j.cleaner, arrivedAt: j.arrivedAt,
  arrivalToday: !!j.arrivalToday, seq: j.seq || null, dayCount: j.dayCount || null, reportDone: !!j.reportDone,
});

async function jobOf(req) {
  const key = jobs.keyFromJobToken(req.params.token);
  return key ? jobs.jobByKey(key) : null;
}

router.get('/job/:token', async (req, res, next) => {
  try {
    const found = await jobOf(req);
    if (!found) return invalid(res);
    const j = found.job;
    const row = await require('../lib/prisma').cleanArrival.findUnique({ where: { jobKey: j.key }, select: { lang: true, langName: true, chat: true } });
    // This clean's language, or the one the cleaner confirmed before (team page).
    found.lang = row && row.lang ? { code: row.lang, name: row.langName || row.lang }
      : await require('../utils/cleanerAssistant').knownLanguage(j).catch(() => null);
    found.chat = row && Array.isArray(row.chat) ? row.chat.slice(-40).map((m) => ({ role: m.role, text: m.text })) : [];
    res.set('Cache-Control', 'no-store');
    const day = await jobs.dayOf(j).catch(() => [j]);
    res.json({
      job: view(j), hostId: j.hostId, propertyId: j.propertyId, unitId: j.unitId,
      // All of this cleaner's cleans that day, in order: the tabs at the top of the report.
      day: day.map((d) => ({ ...view(d), link: d.link, current: d.key === j.key })),
      lang: found.lang || null, chat: found.chat,
      today: jobs.todaySAST(), dayLink: j.cleaner ? jobs.dayLink(j.hostId, j.cleaner, j.date) : null,
    });
  } catch (e) { next(e); }
});

router.post('/job/:token/arrive', async (req, res, next) => {
  try {
    const found = await jobOf(req);
    if (!found) return invalid(res);
    if (found.job.arrivedAt) return res.json({ arrivedAt: found.job.arrivedAt, already: true });
    res.json({ arrivedAt: await jobs.markArrived(found.job) });
  } catch (e) { next(e); }
});

// POST /job/:token/translate { lang: { code, name }, strings: [...] } — the report's
// text in the cleaner's language (saved, so each text is translated once).
router.post('/job/:token/translate', async (req, res, next) => {
  try {
    const found = await jobOf(req);
    if (!found) return invalid(res);
    const { translateTexts, cleanLang } = require('../utils/translate');
    const lang = cleanLang((req.body || {}).lang);
    const strings = Array.isArray((req.body || {}).strings) ? req.body.strings.slice(0, 400) : [];
    if (!lang) return res.status(400).json({ error: 'bad_lang' });
    res.json({ lang, map: lang.code === 'en' ? {} : await translateTexts(lang, strings) });
  } catch (e) { next(e); }
});

// POST /job/:token/language { code, name } — remember the cleaner's language on the clean.
router.post('/job/:token/language', async (req, res, next) => {
  try {
    const found = await jobOf(req);
    if (!found) return invalid(res);
    const lang = require('../utils/translate').cleanLang(req.body || {});
    if (!lang) return res.status(400).json({ error: 'bad_lang' });
    const assistant = require('../utils/cleanerAssistant');
    await assistant.saveTurns(found.job, [], lang);
    await assistant.confirmLanguage(found.job, lang).catch(() => {});
    res.json({ ok: true, lang });
  } catch (e) { next(e); }
});

// POST /job/:token/chat { messages: [{ role, text }], lang, progress } — the helper's reply.
router.post('/job/:token/chat', async (req, res, next) => {
  try {
    const found = await jobOf(req);
    if (!found) return invalid(res);
    const job = found.job;
    if (!job.arrivedAt) return res.status(409).json({ error: 'not_arrived', message: "Tap \"I've arrived\" first." });
    const b = req.body || {};
    const assistant = require('../utils/cleanerAssistant');
    const lang = require('../utils/translate').cleanLang(b.lang);
    const messages = Array.isArray(b.messages) ? b.messages : [];
    const last = messages[messages.length - 1];
    const start = !!b.start && !messages.length;
    if (!start && (!last || last.role !== 'cleaner' || !String(last.text || '').trim())) return res.status(400).json({ error: 'no_message' });
    let unitFacts = '';
    try { unitFacts = job.propertyId ? (await require('../utils/askSimon').factsFor(job.propertyId, job.unitId)).text : ''; } catch (e) { /* facts optional */ }
    const day = await jobs.dayOf(job).catch(() => [job]);
    const out = await assistant.reply({ job, day, unitFacts, lang, progress: b.progress, messages, start });
    const text = out.reply || (out.offline
      ? 'The helper is resting right now. Carry on with your report, and WhatsApp Simon if you need anything.'
      : 'Sorry, I didn’t catch that. Could you say it again?');
    const turns = start ? [{ role: 'helper', text }] : [{ role: 'cleaner', text: String(last.text).slice(0, 2000) }, { role: 'helper', text }];
    await assistant.saveTurns(job, turns, out.language || null, out.condition).catch(() => {});
    // The cleaner picked or switched language in the chat: remember it on the team page.
    if (out.language) await assistant.confirmLanguage(job, out.language).catch(() => {});
    if (out.alert) {
      await require('../utils/payments').alertHost({ hostId: job.hostId },
        `🚨 ${job.cleaner || 'Your cleaner'} at ${job.place}
${out.alert}
They said: "${String((last && last.text) || '').slice(0, 300)}"`).catch(() => {});
    }
    res.json({ reply: text, language: out.language || null, alerted: !!out.alert });
  } catch (e) { next(e); }
});

// POST /job/:token/photo { dataBase64, contentType } — a photo sent in the helper
// chat (for example the state of the unit on arrival). It's attached to this
// clean's report when the report is submitted.
router.post('/job/:token/photo', async (req, res, next) => {
  try {
    const found = await jobOf(req);
    if (!found) return invalid(res);
    const job = found.job;
    if (!job.arrivedAt) return res.status(409).json({ error: 'not_arrived' });
    const prisma = require('../lib/prisma');
    const img = require('./public').decodeFormPhoto(req.body || {});
    if (!img) return res.status(400).json({ error: 'no_image', message: 'That doesn’t look like a photo.' });
    const n = await prisma.photo.count({ where: { cleanJobKey: job.key } });
    if (n >= 40) return res.status(400).json({ error: 'too_many', message: 'That’s plenty of photos for now. Add more in the report.' });
    const { toRenderable } = require('../utils/imagePrep');
    const out = await toRenderable(img.buffer, img.contentType);
    const contentHash = require('crypto').createHash('sha256').update(out.buffer).digest('hex');
    const dup = await prisma.photo.findFirst({ where: { cleanJobKey: job.key, contentHash }, select: { id: true } });
    if (dup) return res.json({ id: dup.id, duplicate: true });
    const photo = await prisma.photo.create({ data: { cleanJobKey: job.key, fieldId: 'arrival_photos', data: out.buffer, contentHash, contentType: out.contentType, filename: (req.body && req.body.filename) || null } });
    res.status(201).json({ id: photo.id });
  } catch (e) { next(e); }
});

router.get('/day/:token', async (req, res, next) => {
  try {
    const d = jobs.fromDayToken(req.params.token);
    if (!d) return invalid(res);
    const list = (await jobs.jobsForDay(d.date, { hostId: d.hostId }))
      .filter((j) => String(j.cleaner || '').trim().toLowerCase() === d.cleaner);
    res.set('Cache-Control', 'no-store');
    res.json({ date: d.date, today: jobs.todaySAST(), jobs: list.map((j) => ({ ...view(j), link: j.link })) });
  } catch (e) { next(e); }
});

module.exports = router;
