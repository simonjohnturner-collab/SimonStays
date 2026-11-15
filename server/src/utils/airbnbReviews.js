// Airbnb guest reviews, read from the "X left a 5-star review" emails Airbnb
// sends once a review is published. Airbnb has no review feed for hosts outside
// its partner API, but these emails carry everything the shopfront needs: the
// stars, the public review text, the listing and the stay dates.
//
// Each review is matched to the Airbnb booking with the same dates (and so to
// its unit and property). Failing that, it's matched to a property by the
// listing name. Saved once per review: re-reading an email changes nothing.
const prisma = require('../lib/prisma');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Is this one of the published-review emails (not "wrote you a review", which
// hides the review until the host writes theirs)?
const isReviewEmail = (subject) => /left a \d-star review|rated their stay \d star/i.test(String(subject || ''));

// Airbnb pads its emails with invisible characters; strip them and tidy lines.
function cleanText(text) {
  return String(text || '')
    .replace(/[͏­​-‍⁠﻿]/g, '')
    .replace(/\r/g, '')
    .split('\n').map((l) => l.trim())
    .filter((l) => l && l !== '%opentrack%' && !/^\[?https?:\/\/\S+\]?$/.test(l))
    .join('\n');
}

// "Oct 31 – Nov 2, 2026", "Oct 10 – 31, 2026", "Dec 28, 2025 – Jan 3, 2026"
// → { start, end } as YYYY-MM-DD, or null.
function parseStay(line) {
  const m = String(line || '').match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\s*[–—-]\s*(?:([A-Za-z]{3})[a-z]*\.?\s+)?(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const sm = MONTHS[m[1].toLowerCase()];
  const em = m[4] ? MONTHS[m[4].toLowerCase()] : sm;
  if (sm == null || em == null) return null;
  const ey = Number(m[6]);
  const sy = m[3] ? Number(m[3]) : (sm > em ? ey - 1 : ey);
  const d = (y, mo, day) => `${y}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { start: d(sy, sm, Number(m[2])), end: d(ey, em, Number(m[5])) };
}

// Pull the review out of one email. `text` is the plain-text part, `html` the
// HTML part (only used for the review id in a link). Null if it isn't a review.
function parseAirbnbReview({ subject = '', text = '', html = '', messageId = '', date = null } = {}) {
  if (!isReviewEmail(subject)) return null;
  const lines = cleanText(text).split('\n');
  const all = lines.join('\n');

  const starsMatch = all.match(/OVERALL RATING\s+(\d)/i) || all.match(/RATED THEIR STAY (\d) STARS?/i) || String(subject).match(/(\d)-star/i);
  const stars = starsMatch ? Number(starsMatch[1]) : null;
  if (!stars || stars < 1 || stars > 5) return null;

  // "Paballo left a 5-star review!" → Paballo. "A recent guest …" stays anonymous.
  const nameMatch = String(subject).match(/^(.+?)\s+left a \d-star review/i);
  const guestFirstName = nameMatch && !/^a recent guest$/i.test(nameMatch[1].trim()) ? nameMatch[1].trim().split(/\s+/)[0] : null;

  // The listing and the dates follow "FEEDBACK FROM THEIR STAY".
  let listingName = null; let stay = null;
  const fb = lines.findIndex((l) => /^FEEDBACK FROM THEIR STAY$/i.test(l));
  if (fb >= 0) {
    for (let i = fb + 1; i < Math.min(lines.length, fb + 6); i++) {
      const s = parseStay(lines[i]);
      if (s) { stay = s; break; }
      if (!listingName && !/^OVERALL RATING/i.test(lines[i])) listingName = lines[i];
    }
  }

  // The public review: the lines after "OVERALL RATING n", up to the next
  // section heading. Airbnb cuts long ones off with "+ More".
  let comment = null;
  const ov = lines.findIndex((l) => /^OVERALL RATING\s+\d/i.test(l));
  if (ov >= 0) {
    const body = [];
    for (let i = ov + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^(NOTE FROM\b|SPECIAL THANKS|WHAT TO WORK ON|Read full review|Write a response)/i.test(l)) break;
      body.push(l);
    }
    const joined = body.join(' ').replace(/\s+/g, ' ').trim();
    const cut = /\+\s*More$/i.test(joined);
    comment = joined.replace(/\s*\+\s*More$/i, '').trim();
    if (comment && cut) comment = comment.replace(/[\s,.;:]+$/, '') + '…';
    comment = comment && /\p{L}/u.test(comment) ? comment.slice(0, 1000) : null; // a lone "." isn't a review
  }

  const idMatch = `${text}\n${html}`.match(/progress\/reviews\/details\/(\d{6,})/);
  const externalKey = idMatch ? `airbnb:${idMatch[1]}` : (messageId ? `msg:${messageId}` : null);
  if (!externalKey) return null;

  return { externalKey, stars, guestFirstName, listingName, stayStart: stay ? stay.start : null, stayEnd: stay ? stay.end : null, comment, reviewedAt: date ? new Date(date) : new Date() };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dayRange = (ymd) => ({ gte: new Date(`${ymd}T00:00:00Z`), lt: new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 864e5) });

// Does an Airbnb listing title look like this unit? "304 The Vantage" ↔ unit 304 at Vantage.
function listingScore(listing, unit) {
  const l = ` ${norm(listing)} `;
  let score = 0;
  if (unit.property && norm(unit.property.name) && l.includes(` ${norm(unit.property.name)} `)) score += 2;
  if (unit.name && l.includes(` ${norm(unit.name)} `)) score += 1;
  return score;
}

// Which booking, unit and property a review belongs to.
async function matchReview(hostId, r) {
  if (r.stayStart && r.stayEnd) {
    const bookings = await prisma.booking.findMany({
      where: { source: 'airbnb', checkIn: dayRange(r.stayStart), checkOut: dayRange(r.stayEnd), unit: { property: { hostId } } },
      include: { unit: { include: { property: true } } },
    });
    if (bookings.length) {
      const first = r.guestFirstName ? norm(r.guestFirstName) : '';
      const ranked = bookings
        .map((b) => ({ b, score: listingScore(r.listingName, b.unit) * 2 + (first && norm(b.guestName).split(' ')[0] === first ? 3 : 0) }))
        .sort((x, y) => y.score - x.score);
      const b = ranked[0].b;
      return { bookingId: b.id, unitId: b.unitId, propertyId: b.unit.propertyId };
    }
  }
  if (r.listingName) {
    const units = await prisma.unit.findMany({ where: { property: { hostId } }, include: { property: true } });
    const ranked = units.map((u) => ({ u, score: listingScore(r.listingName, u) })).filter((x) => x.score > 0).sort((x, y) => y.score - x.score);
    if (ranked.length) {
      // Only the property is sure when just its name matched.
      const top = ranked[0];
      return { bookingId: null, unitId: top.score >= 3 ? top.u.id : null, propertyId: top.u.propertyId };
    }
  }
  return { bookingId: null, unitId: null, propertyId: null };
}

// Save a parsed review once. Answers 'created' | 'updated' | 'unchanged'.
async function saveAirbnbReview(hostId, r) {
  const existing = await prisma.channelReview.findUnique({ where: { hostId_externalKey: { hostId, externalKey: r.externalKey } } });
  // Already placed on a property: nothing to do. Otherwise try matching again
  // (the booking may have synced since).
  if (existing && existing.propertyId) return 'unchanged';
  const where = await matchReview(hostId, r);
  const data = {
    channel: 'airbnb', stars: r.stars, comment: r.comment, guestFirstName: r.guestFirstName, listingName: r.listingName,
    stayStart: r.stayStart ? new Date(`${r.stayStart}T12:00:00Z`) : null, stayEnd: r.stayEnd ? new Date(`${r.stayEnd}T12:00:00Z`) : null,
    reviewedAt: r.reviewedAt, ...where,
  };
  if (existing) { await prisma.channelReview.update({ where: { id: existing.id }, data }); return 'updated'; }
  await prisma.channelReview.create({ data: { hostId, externalKey: r.externalKey, ...data } });
  return 'created';
}

module.exports = { isReviewEmail, parseAirbnbReview, parseStay, saveAirbnbReview, matchReview };
