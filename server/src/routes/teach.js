// "Teach Simon" — the host side of Ask Simon: answer the questions Simon couldn't,
// correct ones it got wrong, and manage everything Simon knows.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const askSimon = require('../utils/askSimon');

const router = express.Router();
router.use(authHost);

async function ownedPropertyId(hostId, propertyId) {
  if (!propertyId) return null;
  const p = await prisma.property.findFirst({ where: { id: propertyId, hostId }, select: { id: true } });
  if (!p) throw Object.assign(new Error('Unknown property.'), { status: 400 });
  return p.id;
}

// GET /teach/count — questions waiting for the host (for the badge).
router.get('/count', async (req, res, next) => {
  try { res.json({ count: await prisma.askQuestion.count({ where: { hostId: req.hostId, status: 'needs_answer' } }) }); }
  catch (e) { next(e); }
});

// GET /teach/status — is Simon switched on (API key present)?
router.get('/status', (req, res) => res.json({ enabled: askSimon.enabled(), model: askSimon.MODEL }));

// GET /teach/questions?status=needs_answer|answered|taught — newest first.
router.get('/questions', async (req, res, next) => {
  try {
    const status = ['needs_answer', 'answered', 'taught'].includes(req.query.status) ? req.query.status : 'needs_answer';
    const qs = await prisma.askQuestion.findMany({
      where: { hostId: req.hostId, status },
      orderBy: { createdAt: status === 'needs_answer' ? 'asc' : 'desc' },
      take: 100,
      include: { property: { select: { name: true } } },
    });
    const guestIds = [...new Set(qs.map((q) => q.guestAccountId).filter(Boolean))];
    const guests = guestIds.length ? await prisma.guestAccount.findMany({ where: { id: { in: guestIds } }, select: { id: true, name: true, email: true } }) : [];
    const byId = Object.fromEntries(guests.map((g) => [g.id, g]));
    res.json({
      questions: qs.map((q) => ({
        id: q.id, question: q.question, answer: q.answer, hostAnswer: q.hostAnswer, status: q.status,
        propertyId: q.propertyId, propertyName: q.property ? q.property.name : null,
        guest: q.guestAccountId && byId[q.guestAccountId] ? (byId[q.guestAccountId].name || byId[q.guestAccountId].email) : null,
        hasBooking: !!q.bookingId, createdAt: q.createdAt, answeredAt: q.answeredAt,
      })),
    });
  } catch (e) { next(e); }
});

// POST /teach/questions/:id/answer { answer, question?, scope: 'property'|'all' }
// Also used to correct an answer Simon gave.
router.post('/questions/:id/answer', async (req, res, next) => {
  try {
    const { answer, question, scope } = req.body || {};
    if (!String(answer || '').trim()) return res.status(400).json({ error: 'empty', message: 'Type the answer first.' });
    const r = await askSimon.teach(req.hostId, req.params.id, { answer: String(answer), question: question ? String(question) : null, scope: scope === 'all' ? 'all' : 'property' });
    if (!r) return res.status(404).json({ error: 'not_found' });
    // Re-asking the waiting questions runs in the background; the list refreshes later.
    r.retry.then((s) => { if (s.resolved) console.log('[ask-simon] cleared', s.resolved, 'waiting question(s) after teaching'); }).catch(() => {});
    res.json({ question: r.question, knowledge: r.knowledge, delivered: r.delivered });
  } catch (e) { next(e); }
});

// POST /teach/questions/:id/dismiss — not worth answering (spam, off-topic).
router.post('/questions/:id/dismiss', async (req, res, next) => {
  try {
    const r = await prisma.askQuestion.updateMany({ where: { id: req.params.id, hostId: req.hostId }, data: { status: 'dismissed' } });
    if (!r.count) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- What Simon knows ----

router.get('/knowledge', async (req, res, next) => {
  try {
    const entries = await prisma.knowledgeEntry.findMany({
      where: { hostId: req.hostId }, orderBy: { updatedAt: 'desc' },
      include: { property: { select: { name: true } } },
    });
    res.json({ entries: entries.map((k) => ({ ...k, propertyName: k.property ? k.property.name : null, property: undefined })) });
  } catch (e) { next(e); }
});

router.post('/knowledge', async (req, res, next) => {
  try {
    const { question, answer, propertyId } = req.body || {};
    if (!String(question || '').trim() || !String(answer || '').trim()) return res.status(400).json({ error: 'invalid', message: 'Add both a question and an answer.' });
    const entry = await prisma.knowledgeEntry.create({
      data: { hostId: req.hostId, propertyId: await ownedPropertyId(req.hostId, propertyId), question: String(question).trim(), answer: String(answer).trim() },
    });
    askSimon.retryWaiting(req.hostId, entry.propertyId).catch(() => {});
    res.status(201).json({ entry });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: 'invalid', message: e.message });
    next(e);
  }
});

router.patch('/knowledge/:id', async (req, res, next) => {
  try {
    const k = await prisma.knowledgeEntry.findFirst({ where: { id: req.params.id, hostId: req.hostId } });
    if (!k) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {}, data = {};
    if ('question' in b && String(b.question).trim()) data.question = String(b.question).trim();
    if ('answer' in b && String(b.answer).trim()) data.answer = String(b.answer).trim();
    if ('propertyId' in b) data.propertyId = await ownedPropertyId(req.hostId, b.propertyId);
    const entry = await prisma.knowledgeEntry.update({ where: { id: k.id }, data });
    res.json({ entry });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: 'invalid', message: e.message });
    next(e);
  }
});

router.delete('/knowledge/:id', async (req, res, next) => {
  try {
    const r = await prisma.knowledgeEntry.deleteMany({ where: { id: req.params.id, hostId: req.hostId } });
    if (!r.count) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
