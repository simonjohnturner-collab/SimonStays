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
    res.set('Cache-Control', 'no-store');
    res.json({
      job: view(j), hostId: j.hostId, propertyId: j.propertyId, unitId: j.unitId,
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
