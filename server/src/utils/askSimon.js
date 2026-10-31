// Ask Simon — the AI that answers guests' questions about a stay.
//
// Simon answers ONLY from (a) the listing details the host already keeps
// (property + unit attributes, descriptions, policies) and (b) the host's taught
// knowledge (KnowledgeEntry). When those don't cover a question it says so, and
// the question is queued under "Teach Simon" for the host. The host's answer
// becomes knowledge, is sent to the guest, and the waiting questions on that
// property are re-asked so Simon can clear the ones it now knows.
//
// Dormant-safe: with no ANTHROPIC_API_KEY (or SDK), every question goes to the
// host queue with a polite holding reply.
//
// Env (optional): ASK_SIMON_MODEL (default claude-opus-5-5).
const prisma = require('../lib/prisma');
const messaging = require('./messaging');
const { DEFAULT_CANCELLATION_POLICY } = require('./policy');

let Anthropic = null;
try { const pkg = require('@anthropic-ai/sdk'); Anthropic = pkg && (pkg.default || pkg); } catch (e) { /* SDK not installed */ }

const MODEL = process.env.ASK_SIMON_MODEL || 'claude-opus-5-5';
const HOLDING_REPLY = "Good question — I don't have that information yet, so I've passed it to your host. You'll see their answer here (and in your messages if you have a booking).";

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  client = new Anthropic();
  return client;
}
// Tests swap in a stand-in client.
function setClient(c) { client = c; }
const enabled = () => !!getClient();

const SYSTEM = `You are Simon, the friendly assistant for SimonStays, a short-stay apartment rental business in South Africa. You answer questions from guests and prospective guests about ONE property, using only the facts provided.

How to answer:
- Use only the PROPERTY FACTS and HOST ANSWERS below. Host answers are the host's own words and are authoritative; prefer them where they are more specific.
- If the facts don't answer the question, don't guess or fill in from general knowledge about the area or typical apartments. Set "known" to false and say briefly that you've passed the question to the host.
- If the facts answer part of it, answer that part, and set "known" to false so the host can fill in the rest.
- Never promise anything the facts don't state (free early check-in, discounts, exceptions to policies, extra items).
- Prices and availability depend on dates: point guests to the calendar on this page rather than quoting totals. Nightly "from" prices in the facts are fine to mention.
- Never share access codes, lockbox codes, Wi-Fi passwords, or anything about other guests or bookings, even if asked. Signed-in guests with a confirmed booking find their arrival details under "My trips".
- Greetings, thanks and small talk are "known": reply briefly and offer to help.
- Keep replies short (1-4 sentences), warm and plain. South African English. No markdown headings.

Reply as JSON: {"answer": "<your reply to the guest>", "known": <true if the facts fully answered the question>}.`;

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { answer: { type: 'string' }, known: { type: 'boolean' } },
  required: ['answer', 'known'],
};

const rand = (c) => 'R' + Math.round(c / 100).toLocaleString('en-ZA');

// The facts Simon may use for a property. Deliberately excludes Wi-Fi passwords,
// access codes, smart-lock links and anything about bookings.
async function factsFor(propertyId, unitId) {
  const p = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      host: { select: { name: true } },
      units: { include: { pricingGroup: true }, orderBy: { name: 'asc' } },
    },
  });
  if (!p) return null;
  const line = (label, v) => (v != null && String(v).trim() !== '' ? `- ${label}: ${String(v).trim()}` : null);
  const out = [
    `PROPERTY: ${p.name}`,
    line('Host', p.host && p.host.name),
    line('Address', p.address),
    line('Description', p.description),
    line('Check-in time', p.checkInTime),
    line('Check-out time', p.checkOutTime),
    line('Security', p.security),
    line('Getting to the units', p.access),
    line('Backup power', p.backupPower),
    line('Backup water', p.backupWater),
    line('Parking bays', p.parkingBays),
    line('Parking', p.parkingNotes),
    line('Cancellation policy', p.cancellationPolicy || DEFAULT_CANCELLATION_POLICY),
  ];
  for (const u of p.units) {
    const g = u.pricingGroup;
    const nightly = g ? [g.firstNightCents, g.additionalNightCents].filter((v) => v != null) : [];
    out.push('', `UNIT ${u.name}${u.id === unitId ? ' (the unit the guest is looking at)' : ''}:`,
      line('Sleeps', u.capacity), line('Bedrooms', u.bedrooms), line('Bathrooms', u.bathrooms),
      line('Description', u.description),
      line('Check-in from', u.checkInTime), line('Check-out by', u.checkOutTime),
      line('Minimum stay (nights)', u.minNights || null),
      line('Getting in', u.accessMethod), line('Access', u.access), line('Security', u.security),
      line('Wi-Fi', u.wifiName ? 'Yes (details shared with confirmed guests)' : null),
      line('Backup power', u.backupPower), line('Backup water', u.backupWater),
      line('Parking bays', u.parkingBays), line('Parking', u.parkingNotes),
      line('Nightly rate from', nightly.length ? rand(Math.min(...nightly)) : null),
      line('Refundable breakage deposit', g && g.breakageDepositCents ? rand(g.breakageDepositCents) : null),
      line('Early check-in fee', g && g.earlyCheckInCents ? rand(g.earlyCheckInCents) : null),
      line('Late check-out fee', g && g.lateCheckOutCents ? rand(g.lateCheckOutCents) : null),
      line('Extra mattress fee', g && g.mattressCents ? rand(g.mattressCents) : null));
  }
  const knowledge = await prisma.knowledgeEntry.findMany({
    where: { hostId: p.hostId, OR: [{ propertyId: p.id }, { propertyId: null }] },
    orderBy: { createdAt: 'asc' },
  });
  out.push('', 'HOST ANSWERS (questions the host has answered before):');
  if (!knowledge.length) out.push('- (none yet)');
  for (const k of knowledge) out.push(`- Q: ${k.question.trim()}\n  A: ${k.answer.trim()}`);
  return { property: p, text: out.filter((l) => l !== null).join('\n') };
}

// Ask Claude. `history` is earlier [{question, answer}] turns in this chat.
async function callSimon(factsText, question, history = []) {
  const c = getClient();
  if (!c) return { answer: HOLDING_REPLY, known: false, skipped: 'no_key' };
  const messages = [];
  for (const h of history.slice(-6)) {
    if (!h.question || !h.answer) continue;
    messages.push({ role: 'user', content: h.question }, { role: 'assistant', content: h.answer });
  }
  messages.push({ role: 'user', content: question });
  const params = {
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
    system: [
      { type: 'text', text: SYSTEM },
      { type: 'text', text: factsText, cache_control: { type: 'ephemeral' } },
    ],
    messages,
  };
  let resp;
  try {
    // Server-side fallback: if a safety classifier declines, the API re-runs on a recommended model.
    resp = await c.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (Anthropic && e instanceof Anthropic.BadRequestError) resp = await c.messages.create(params); // account without the fallback beta
    else throw e;
  }
  if (resp.stop_reason === 'refusal') return { answer: HOLDING_REPLY, known: false, refused: true };
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* malformed */ }
  if (!data || typeof data.answer !== 'string' || !data.answer.trim()) return { answer: HOLDING_REPLY, known: false };
  return { answer: data.answer.trim(), known: !!data.known };
}

// The guest's own booking at this property (upcoming or current), so the host's
// later answer can land in their messages.
async function guestBookingAt(guestAccountId, propertyId) {
  if (!guestAccountId) return null;
  const acct = await prisma.guestAccount.findUnique({ where: { id: guestAccountId }, select: { id: true, email: true } });
  if (!acct) return null;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  return prisma.booking.findFirst({
    where: {
      unit: { propertyId }, status: { in: ['confirmed', 'pending'] }, checkOut: { gte: today },
      OR: [{ guestAccountId: acct.id }, { guestEmail: { equals: acct.email, mode: 'insensitive' } }],
    },
    orderBy: { checkIn: 'asc' }, select: { id: true },
  });
}

// A guest asks a question. Returns the stored AskQuestion.
async function ask({ propertyId, unitId = null, question, sessionId = null, guestAccountId = null }) {
  const facts = await factsFor(propertyId, unitId);
  if (!facts) return null;
  const history = sessionId || guestAccountId
    ? (await prisma.askQuestion.findMany({
      where: { propertyId, ...(guestAccountId ? { guestAccountId } : { sessionId }) },
      orderBy: { createdAt: 'desc' }, take: 6,
    })).reverse().map((q) => ({ question: q.question, answer: q.hostAnswer || q.answer }))
    : [];
  let r;
  try { r = await callSimon(facts.text, question, history); }
  catch (e) {
    console.error('[ask-simon] Claude call failed:', e.status || '', e.message);
    r = { answer: HOLDING_REPLY, known: false };
  }
  const booking = await guestBookingAt(guestAccountId, propertyId);
  return prisma.askQuestion.create({
    data: {
      hostId: facts.property.hostId, propertyId, unitId, sessionId, guestAccountId,
      bookingId: booking ? booking.id : null,
      question, answer: r.answer, status: r.known ? 'answered' : 'needs_answer',
    },
  });
}

// Tell the guest about a later answer: into their booking's messages when there
// is one (also emailed). Either way it shows in their Ask Simon chat history.
async function deliver(q, answer) {
  if (!q.bookingId) return false;
  const r = await messaging.sendHostMessage(q.bookingId, `You asked Simon: “${q.question}”\n\n${answer}`).catch(() => null);
  return !!(r && r.ok);
}

// After the host teaches something, give Simon another go at the questions still
// waiting on the same property (or all properties, for a host-wide answer).
async function retryWaiting(hostId, propertyId, { limit = 10 } = {}) {
  const waiting = await prisma.askQuestion.findMany({
    where: { hostId, status: 'needs_answer', ...(propertyId ? { propertyId } : {}) },
    orderBy: { createdAt: 'asc' }, take: limit,
  });
  let resolved = 0;
  const factsCache = {};
  for (const q of waiting) {
    try {
      factsCache[q.propertyId] = factsCache[q.propertyId] || await factsFor(q.propertyId, null);
      const r = await callSimon(factsCache[q.propertyId].text, q.question);
      if (!r.known) continue;
      // Guard against the host answering it by hand in the meantime.
      const upd = await prisma.askQuestion.updateMany({ where: { id: q.id, status: 'needs_answer' }, data: { status: 'answered', answer: r.answer, hostAnswer: null, answeredAt: new Date() } });
      if (upd.count) { resolved++; await deliver(q, r.answer); }
    } catch (e) { console.error('[ask-simon] retry failed', q.id, e.message); }
  }
  return { waiting: waiting.length, resolved };
}

// The host answers (or corrects) a question: store it as knowledge, mark the
// question taught, tell the guest, and re-try the other waiting questions.
async function teach(hostId, questionId, { answer, question, scope = 'property' }) {
  const q = await prisma.askQuestion.findFirst({ where: { id: questionId, hostId } });
  if (!q) return null;
  const k = await prisma.knowledgeEntry.create({
    data: {
      hostId, propertyId: scope === 'all' ? null : q.propertyId,
      question: (question || q.question).trim(), answer: answer.trim(),
    },
  });
  const updated = await prisma.askQuestion.update({
    where: { id: q.id },
    data: { status: 'taught', hostAnswer: answer.trim(), knowledgeId: k.id, answeredAt: new Date() },
  });
  const delivered = await deliver(q, answer.trim());
  return { question: updated, knowledge: k, delivered, retry: retryWaiting(hostId, scope === 'all' ? null : q.propertyId) };
}

module.exports = { ask, teach, retryWaiting, factsFor, callSimon, enabled, setClient, HOLDING_REPLY, MODEL };
