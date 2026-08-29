// Date-only helpers. Bookings arrive as ISO noon-UTC strings; we compare by the
// YYYY-MM-DD prefix so no timezone math is needed on the client.

export function ymd(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.toISOString().slice(0, 10);
}

export function today() {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), 12));
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** Array of Date objects (noon UTC) for a window. */
export function range(start, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(addDays(start, i));
  return out;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function weekday(d) { return WD[new Date(d).getUTCDay()]; }
export function dayMonth(d) { const x = new Date(d); return `${x.getUTCDate()} ${MO[x.getUTCMonth()]}`; }
export function isWeekend(d) { const w = new Date(d).getUTCDay(); return w === 0 || w === 6; }
export function prettyDate(iso) { const x = new Date(iso); return `${weekday(x)} ${x.getUTCDate()} ${MO[x.getUTCMonth()]}`; }
