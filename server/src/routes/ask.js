// Public "Ask Simon" API for the shopfront. Anyone viewing a stay can ask; a
// signed-in guest's questions are tied to their account (and booking, if any).
// Each question is a paid Claude call, so it's rate-limited per IP and session.
const express = require('express');
const prisma = require('../lib/prisma');
const { optionalGuest } = require('../middleware/auth');
const askSimon = require('../utils/askSimon');

const router = express.Router();
router.use(optionalGuest);

const MAX_LEN = 500;
const LIMITS = { ip: 40, session: 25 }; // questions per hour
const hits = new Map(); // key -> [timestamps]
function overLimit(key, max) {
  const now = Date.now(), cutoff = now - 60 * 60 * 1000;
  const list = (hits.get(key) || []).filter((t) => t > cutoff);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => t > cutoff)) hits.delete(k);
  return false;
}
const cleanSession = (s) => (typeof s === 'string' && /^[\w-]{8,64}$/.test(s) ? s : null);

const out = (q) => ({
  id: q.id, question: q.question, createdAt: q.createdAt,
  // Once the host has answered, the guest sees the host's answer.
  answer: q.hostAnswer || q.answer, waiting: q.status === 'needs_answer', fromHost: !!q.hostAnswer,
});

// POST /public/ask { propertyId, unitId?, question, sessionId }
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const question = String(b.question || '').trim();
    const sessionId = cleanSession(b.sessionId);
    if (!question) return res.status(400).json({ error: 'empty', message: 'Type a question first.' });
    if (question.length > MAX_LEN) return res.status(400).json({ error: 'too_long', message: `Please keep it under ${MAX_LEN} characters.` });
    if (overLimit('ip:' + req.ip, LIMITS.ip) || (sessionId && overLimit('s:' + sessionId, LIMITS.session))) {
      return res.status(429).json({ error: 'rate_limited', message: "You've asked a lot of questions — please try again a bit later, or message your host." });
    }
    const property = await prisma.property.findUnique({ where: { id: String(b.propertyId || '') }, select: { id: true } });
    if (!property) return res.status(404).json({ error: 'not_found' });
    const unit = b.unitId ? await prisma.unit.findFirst({ where: { id: String(b.unitId), propertyId: property.id }, select: { id: true } }) : null;
    const q = await askSimon.ask({ propertyId: property.id, unitId: unit ? unit.id : null, question, sessionId, guestAccountId: req.guestId || null });
    res.status(201).json({ question: out(q) });
  } catch (e) { next(e); }
});

// GET /public/ask/history?propertyId=&sessionId= — this visitor's earlier questions
// on a property, including answers the host has since given.
router.get('/history', async (req, res, next) => {
  try {
    const sessionId = cleanSession(req.query.sessionId);
    if (!req.guestId && !sessionId) return res.json({ questions: [] });
    const who = [];
    if (req.guestId) who.push({ guestAccountId: req.guestId });
    if (sessionId) who.push({ sessionId });
    const qs = await prisma.askQuestion.findMany({
      where: { propertyId: String(req.query.propertyId || ''), status: { not: 'dismissed' }, OR: who },
      orderBy: { createdAt: 'asc' }, take: 50,
    });
    res.json({ questions: qs.map(out) });
  } catch (e) { next(e); }
});

module.exports = router;
