// Translating short texts with Claude, saved in the Translation table so each
// text is translated once per language. Used for a cleaner's report in their
// language (and what they type, back into English); later for the shopfront.
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const claude = require('./claude');

const BATCH = 60;
const MAX_LEN = 600;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

// A language the caller asked for: { code: 'zu', name: 'isiZulu' }. Null if unusable.
function cleanLang(lang) {
  const code = String((lang && lang.code) || '').trim().toLowerCase();
  const name = String((lang && lang.name) || '').trim().slice(0, 40);
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code)) return null;
  return { code, name: name || code };
}

const SCHEMA = {
  type: 'object',
  properties: { translations: { type: 'array', items: { type: 'string' } } },
  required: ['translations'],
  additionalProperties: false,
};

function systemFor(lang) {
  return lang.code === 'en'
    ? 'You translate short texts written by cleaners at SimonStays, a South African short-stay rental business, into plain English for the owner. '
      + 'The texts may be in any language, or a mix (isiZulu, Sesotho, Afrikaans, Shona, English and so on). Keep the meaning exactly, including '
      + 'anything about damage, missing items, amounts and times. Keep names, unit numbers, brand names and numbers as they are. If a text is already '
      + 'English, return it unchanged. Return one translation per input text, in the same order.'
    : `You translate the text of a cleaning report app used at SimonStays, a South African short-stay rental business, from English into ${lang.name} (language code ${lang.code}). `
      + 'Write the way everyday speakers talk: short, clear and friendly, not formal or academic. Keep emoji, numbers, times, prices (R…), '
      + 'unit numbers, names and the brand "SimonStays" unchanged. Translate cleaning words naturally (linen, towels, fridge, toiletries); '
      + 'where a common English loanword is what people actually say, use it. Return one translation per input text, in the same order.';
}

async function translateBatch(lang, texts) {
  const resp = await claude.create({
    model: claude.MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: systemFor(lang),
    messages: [{ role: 'user', content: JSON.stringify(texts) }],
  });
  const data = claude.jsonOf(resp);
  if (!data || !Array.isArray(data.translations) || data.translations.length !== texts.length) return null;
  return data.translations.map((t) => String(t || ''));
}

// { source text: translation } for each text. Uses saved translations; asks Claude
// for the rest and saves them. Texts it can't translate map to themselves.
async function translateTexts(langIn, textsIn) {
  const lang = cleanLang(langIn);
  const texts = [...new Set((textsIn || []).map((t) => String(t || '').trim()).filter((t) => t && t.length <= MAX_LEN))];
  const out = {};
  if (!lang || !texts.length) return out;
  const byHash = new Map(texts.map((t) => [hash(t), t]));
  const saved = await prisma.translation.findMany({ where: { lang: lang.code, srcHash: { in: [...byHash.keys()] } } });
  saved.forEach((r) => { out[byHash.get(r.srcHash)] = r.text; });
  const missing = texts.filter((t) => !(t in out));
  if (missing.length && claude.enabled()) {
    for (let i = 0; i < missing.length; i += BATCH) {
      const part = missing.slice(i, i + BATCH);
      let got = null;
      try { got = await translateBatch(lang, part); } catch (e) { console.error('[translate] failed', lang.code, e.message); }
      if (!got) continue;
      for (let k = 0; k < part.length; k++) {
        const text = got[k].trim();
        if (!text) continue;
        out[part[k]] = text;
        await prisma.translation.upsert({
          where: { lang_srcHash: { lang: lang.code, srcHash: hash(part[k]) } },
          create: { lang: lang.code, srcHash: hash(part[k]), src: part[k], text },
          update: { text },
        }).catch(() => {});
      }
    }
  }
  texts.forEach((t) => { if (!(t in out)) out[t] = t; });
  return out;
}

// A report filled in another language: turn what the cleaner typed into English
// for Simon. The original words are kept in answers._original { fieldId: text }.
// Only free-text questions; yes/no, choices, numbers and photos need nothing.
async function reportToEnglish(submissionId) {
  const sub = await prisma.formSubmission.findUnique({ where: { id: submissionId } });
  const a = sub && sub.answers && typeof sub.answers === 'object' ? sub.answers : null;
  if (!a || !a._lang || a._lang === 'en' || a._original) return { skipped: true };
  const tpl = sub.templateId ? await prisma.formTemplate.findUnique({ where: { id: sub.templateId } }) : null;
  const types = {};
  (tpl && Array.isArray(tpl.fields) ? tpl.fields : []).forEach((f) => { if (f && f.id) types[f.id] = f.type; });
  const free = (id) => { const t = types[String(id).split('__')[0]]; return t === 'textarea' || t === 'text' || t === undefined; };
  const ids = Object.keys(a).filter((k) => !k.startsWith('_') && k !== 'date' && typeof a[k] === 'string' && /\p{L}{2}/u.test(a[k]) && free(k));
  if (!ids.length) return { translated: 0 };
  const map = await translateTexts({ code: 'en', name: 'English' }, ids.map((k) => a[k]));
  const original = {};
  const next = { ...a };
  ids.forEach((k) => { const en = map[String(a[k]).trim()]; if (en && en !== String(a[k]).trim()) { original[k] = a[k]; next[k] = en; } });
  next._original = original;
  await prisma.formSubmission.update({ where: { id: sub.id }, data: { answers: next } });
  return { translated: Object.keys(original).length };
}

module.exports = { translateTexts, cleanLang, reportToEnglish };
