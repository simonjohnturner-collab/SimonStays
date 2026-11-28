// The helper inside a cleaner's report (opened from their WhatsApp link, after
// "I've arrived"). It speaks the cleaner's chosen language, starts with a little
// warmth, then helps them organise the clean: which room next, what's left, what
// the notes say. The cleaner fills in the report themselves; the helper never
// claims to. If something is urgent (can't get in, injury, serious damage) it
// flags it and the host is told. The conversation is kept on the clean
// (CleanArrival.chat) so Simon, and later the overseer agent, can read it.
const prisma = require('../lib/prisma');
const claude = require('./claude');

const MAX_TURNS = 30;

const SYSTEM = `You are the SimonStays cleaning helper. You chat with a cleaner on their phone while they clean a short-stay apartment for SimonStays (Simon's holiday-let business in Johannesburg, South Africa). The cleaner is a valued member of the team.

Language: always write in the cleaner's chosen language, given in the notes below. If none is chosen yet, ask which language they would like (in simple English) and offer a few, such as English, isiZulu, isiXhosa, Sesotho, Setswana, Sepedi, Afrikaans, Shona, Chichewa or Portuguese. Whenever the cleaner picks or switches language (in words or by writing in it), set language_code and language_name; otherwise leave both empty. Use everyday, friendly language, not formal language.

How to talk: warm, respectful and brief. One to three short sentences, like a WhatsApp chat. Use their first name now and then. Ask one thing at a time. Don't lecture, don't list long instructions, don't use headings.

The start of the clean, in this order, one step at a time:
1. Greet them and ask how they are and how their family is. Respond kindly to what they share; keep it to an exchange or two.
2. Ask what state the place is in now that they've arrived. Put a short English summary of what they say in arrival_condition (for example "Very dirty: dishes piled up, rubbish in the lounge, stains on the couch").
   - If it is very dirty, messy, smelly or damaged, ask them to take photos now, before cleaning, using the camera button (📷) next to the message box in this chat, as evidence. Thank them when photos arrive (you'll see "[sent N photos]").
   - If the guests are still in the unit, ask whether there is a problem: are they packing to leave, or does Simon need to speak to them? If they're packing or the cleaner can handle it, say that's fine and suggest starting with another area or waiting politely, with no alert. If the guests aren't leaving, there's a problem, or the cleaner wants Simon to step in, set alert_host with a short English summary (unit, what's happening, the time) and tell the cleaner Simon has been told and will contact the guests.
3. Ask whether the guest has left anything behind (clothes, chargers, keys and so on). If yes, ask them to put it in the report section for items left behind (use the section names in the notes), with a photo, and keep the items safe.
4. Then help them work through the report room by room.

Several cleans in a day: the notes list the cleaner's cleans in order. A unit with a guest arriving today must be done first (among those they can get into), because that's where the time pressure is. If they ask what to do next, or they finish this report, tell them which clean is next and that it's in the tabs at the top of the page (each unit has its own report and its own "I've arrived").

Helping with the clean: the cleaner fills in the report on the same page themselves, room by room; you never fill it in and never say you have. Help them organise: suggest which room or section to do next based on what's done and what's left, remind them of the job notes (late checkout, collect the extra mattress, a new guest arriving today), remind them that each room needs its photos, and encourage them. When everything is done, remind them to press Submit at the bottom.

Questions: answer from the job details and the unit information below. If you don't know, say so and suggest they WhatsApp Simon. Never invent codes, passwords or instructions.

Problems: if they report damage, something missing (for example an access fob or remote), or a mess beyond normal, tell them to note it in the report with photos (the "Damaged items" section for damage) so Simon sees it. If something is urgent (they can't get into the unit, they are hurt or unsafe, there is a leak, fire, break-in or serious damage, or the guest is still inside long after checkout), set alert_host to true and write a short English alert_summary for Simon, and tell the cleaner Simon has been told. Otherwise alert_host is false and alert_summary is empty.

Privacy and limits: never share guests' contact details. Don't discuss pay, money owed or disputes beyond saying Simon will sort it out. Keep to the cleaning job and friendly chat.`;

const SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    language_code: { type: 'string' },
    language_name: { type: 'string' },
    alert_host: { type: 'boolean' },
    alert_summary: { type: 'string' },
    arrival_condition: { type: 'string' },
  },
  required: ['reply', 'language_code', 'language_name', 'alert_host', 'alert_summary', 'arrival_condition'],
  additionalProperties: false,
};

function jobNotes(job, unitFacts, day) {
  const order = (day || []).length > 1 ? [
    '',
    "THE CLEANER'S CLEANS TODAY, IN ORDER:",
    ...day.map((d) => `${d.seq || '-'}. ${d.time} ${d.place}, ${d.label.toLowerCase()}${d.arrivalToday ? ', guest arriving today (do first)' : ''}${d.reportDone ? ', report sent' : ''}${d.key === job.key ? '  <- this one' : ''}`),
  ] : [];
  return [
    'JOB:',
    `- ${job.label} at ${job.place}, ${job.date}, expected start ${job.time}`,
    `- Cleaner: ${job.cleaner || 'unknown'}`,
    `- Guest: ${job.guestName || 'unknown'}`,
    ...(job.notes || []).map((n) => `- Note: ${n}`),
    '',
    ...order,
    '',
    'UNIT INFORMATION (from the host):',
    unitFacts || '(none)',
  ].join('\n');
}

const progressLine = (p) => {
  if (!p) return '';
  const list = (a) => (Array.isArray(a) && a.length ? a.slice(0, 30).join(', ') : 'none');
  return `[Report sections so far: done: ${list(p.done)}; partly done: ${list(p.partly)}; still to do: ${list(p.todo)}; optional: ${list(p.optional)}]`;
};

// One turn. `messages` = the chat so far [{ role: 'cleaner'|'helper', text }],
// ending with the cleaner's latest message. With `start` (and no messages) the
// helper opens the chat itself, in the cleaner's known language.
// Returns { reply, language, alert, condition }.
async function reply({ job, day, unitFacts, lang, progress, messages, start = false }) {
  if (!claude.enabled()) return { reply: null, offline: true };
  const turns = (messages || []).slice(-MAX_TURNS).filter((m) => m && m.text && (m.role === 'cleaner' || m.role === 'helper'));
  if (start && !turns.length) turns.push({ role: 'cleaner', text: '[The cleaner has just arrived and opened the helper. Their language is already known from earlier cleans. Greet them in it (step 1). They can change language with the 🌐 button.]' });
  // The API wants the conversation to start with the user; drop a leading helper greeting.
  while (turns.length && turns[0].role === 'helper') turns.shift();
  const api = turns.map((m) => ({ role: m.role === 'cleaner' ? 'user' : 'assistant', content: String(m.text).slice(0, 2000) }));
  if (!api.length || api[api.length - 1].role !== 'user') return { reply: null };
  const langLine = lang && lang.code ? `[Chosen language: ${lang.name} (${lang.code})]` : '[No language chosen yet]';
  api[api.length - 1].content = `${langLine}\n${progressLine(progress)}\n\n${api[api.length - 1].content}`;
  const resp = await claude.create({
    model: claude.MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: [
      { type: 'text', text: SYSTEM },
      { type: 'text', text: jobNotes(job, unitFacts, day), cache_control: { type: 'ephemeral' } },
    ],
    messages: api,
  });
  const d = claude.jsonOf(resp);
  if (!d || !d.reply) return { reply: null };
  const language = d.language_code && d.language_name ? { code: d.language_code.toLowerCase().slice(0, 12), name: d.language_name.slice(0, 40) } : null;
  return {
    reply: d.reply.trim(), language,
    alert: d.alert_host ? (d.alert_summary || 'The cleaner reported something urgent.') : null,
    condition: d.arrival_condition ? d.arrival_condition.trim().slice(0, 500) : null,
  };
}

// The cleaner's entry in the host's Service Providers (team), by name.
function providerOf(job) {
  if (!job.hostId || !job.cleaner) return null;
  return prisma.serviceProvider.findFirst({ where: { hostId: job.hostId, name: { equals: String(job.cleaner).trim(), mode: 'insensitive' } } });
}
// The language a cleaner confirmed on an earlier clean (team page), or null.
async function knownLanguage(job) {
  const p = await providerOf(job);
  return p && p.language ? { code: p.language, name: p.languageName || p.language } : null;
}
// Remember the cleaner's confirmed language on their team entry.
async function confirmLanguage(job, lang) {
  const p = await providerOf(job);
  if (!p || !lang) return false;
  await prisma.serviceProvider.update({ where: { id: p.id }, data: { language: lang.code, languageName: lang.name, languageConfirmedAt: new Date() } });
  return true;
}

// Save turns on the clean (and the language, and how they found the unit).
async function saveTurns(job, turns, lang, condition) {
  const row = await prisma.cleanArrival.findUnique({ where: { jobKey: job.key } });
  const chat = Array.isArray(row && row.chat) ? row.chat : [];
  const at = new Date().toISOString();
  const next = [...chat, ...turns.map((t) => ({ ...t, at }))].slice(-200);
  const data = { chat: next, ...(lang ? { lang: lang.code, langName: lang.name } : {}), ...(condition ? { condition } : {}) };
  await prisma.cleanArrival.upsert({
    where: { jobKey: job.key },
    create: { jobKey: job.key, hostId: job.hostId, date: job.date, cleaner: job.cleaner, ...data },
    update: data,
  });
}

module.exports = { reply, saveTurns, knownLanguage, confirmLanguage, SYSTEM };
