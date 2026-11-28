// POST /public/translate { lang: { code, name }, strings: [...] } — the shopfront in
// the visitor's language (the 🌐 menu). Saved translations are free and unlimited;
// new text goes to Claude, so that is capped per visitor and per day, and only
// for the languages the shopfront offers.
const express = require('express');
const { translateTexts } = require('../utils/translate');

const router = express.Router();
const LANGS = { af: 'Afrikaans', zu: 'isiZulu', xh: 'isiXhosa', st: 'Sesotho', fr: 'Français', de: 'Deutsch', pt: 'Português', es: 'Español', zh: 'Mandarin Chinese (Simplified Chinese characters)' };
const PER_IP_HOUR = 1500; // new texts per visitor per hour
const PER_DAY = 20000; // new texts per day, everyone together
const MAX_STRINGS = 300;
const used = new Map(); // ip -> [{ at, n }]
let day = { key: '', n: 0 };

function ipLeft(ip) {
  const cutoff = Date.now() - 3600e3;
  const list = (used.get(ip) || []).filter((x) => x.at > cutoff);
  used.set(ip, list);
  if (used.size > 5000) for (const [k, v] of used) if (!v.some((x) => x.at > cutoff)) used.delete(k);
  return PER_IP_HOUR - list.reduce((a, x) => a + x.n, 0);
}
function dayLeft() {
  const k = new Date().toISOString().slice(0, 10);
  if (day.key !== k) day = { key: k, n: 0 };
  return PER_DAY - day.n;
}

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const code = String((b.lang && b.lang.code) || '').toLowerCase();
    if (!LANGS[code]) return res.status(400).json({ error: 'bad_lang' });
    const strings = Array.isArray(b.strings) ? b.strings.slice(0, MAX_STRINGS) : [];
    const maxNew = Math.max(0, Math.min(ipLeft(req.ip), dayLeft()));
    const map = await translateTexts({ code, name: LANGS[code] }, strings, {
      context: 'shopfront', maxLen: 3000, maxNew,
      onNew: (n) => { if (n) { used.get(req.ip).push({ at: Date.now(), n }); day.n += n; } },
    });
    res.set('Cache-Control', 'no-store');
    res.json({ lang: { code, name: LANGS[code] }, map, limited: maxNew === 0 });
  } catch (e) { next(e); }
});

module.exports = router;
