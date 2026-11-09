// POST /public/track — events from the analytics tracker (pages/track.js).
// First-party only: no cookies, no IP address stored. Bots are dropped. Each
// visitor is limited to a burst of events per minute so nobody can flood it.
const express = require('express');
const prisma = require('../lib/prisma');
const { verify } = require('../lib/jwt');

// The signed-in guest, if the tracker sent their (verified) token.
function guestOf(token) {
  if (!token) return null;
  try { const p = verify(String(token)); return p.kind === 'guest' && p.guestId ? p.guestId : null; } catch (e) { return null; }
}

const router = express.Router();

const TYPES = new Set(['pageview', 'impression', 'view_listing', 'search', 'click', 'start_checkout', 'booking_placed', 'booked', 'request_sent', 'enquiry_sent', 'signup', 'signin']);
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|preview|facebookexternalhit|whatsapp|telegram/i;
const cut = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const ID = /^[A-Za-z0-9-]{4,64}$/;

const recent = new Map(); // visitorId -> { n, t }
function allow(vid, n) {
  const now = Date.now();
  const r = recent.get(vid);
  if (!r || now - r.t > 60000) { recent.set(vid, { n, t: now }); return true; }
  r.n += n;
  return r.n <= 300;
}
setInterval(() => { const cutoff = Date.now() - 120000; for (const [k, v] of recent) if (v.t < cutoff) recent.delete(k); }, 60000).unref();

router.post('/', async (req, res) => {
  res.status(204).end(); // never make the page wait; store after replying
  try {
    if (BOT.test(req.get('user-agent') || '')) return;
    const b = req.body || {};
    const vid = cut(b.v, 64), sid = cut(b.s, 64);
    if (!vid || !sid || !ID.test(vid) || !ID.test(sid)) return;
    const events = Array.isArray(b.events) ? b.events.slice(0, 25) : [];
    if (!events.length || !allow(vid, events.length)) return;
    const device = ['mobile', 'tablet', 'desktop'].includes(b.d) ? b.d : null;
    const guestAccountId = guestOf(b.g);
    const rows = events.filter((e) => e && TYPES.has(e.t)).map((e) => ({
      visitorId: vid, sessionId: sid, type: e.t,
      path: cut(e.p, 200), label: cut(e.l, 120),
      unitId: e.u && ID.test(String(e.u)) ? String(e.u) : null,
      propertyId: e.pr && ID.test(String(e.pr)) ? String(e.pr) : null,
      meta: e.m && typeof e.m === 'object' && JSON.stringify(e.m).length < 500 ? e.m : undefined,
      device, source: cut(b.src, 80), isHost: !!b.h, guestAccountId,
      bookingId: e.m && ID.test(String(e.m.bookingId || '')) ? String(e.m.bookingId) : null,
    }));
    if (rows.length) await prisma.pageEvent.createMany({ data: rows });
    // Signed in: this browser's earlier anonymous visits are theirs too.
    if (guestAccountId) await prisma.pageEvent.updateMany({ where: { visitorId: vid, guestAccountId: null }, data: { guestAccountId } });
  } catch (e) { console.error('[track] failed', e.message); }
});

// Keep about 13 months of events.
async function prune() {
  try { await prisma.pageEvent.deleteMany({ where: { at: { lt: new Date(Date.now() - 400 * 864e5) } } }); } catch (e) { /* table may not exist yet */ }
}
setTimeout(prune, 60000).unref();
setInterval(prune, 864e5).unref();

module.exports = router;
