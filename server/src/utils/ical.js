/**
 * iCal engine — the heart of channel sync.
 *  - parseFeed(text): normalize any channel's iCal into simple booking events.
 *  - buildFeed(...):  produce the merged blocking calendar channels import back.
 *  - overlaps / date helpers shared by availability checks.
 *
 * Uses node-ical for robust parsing (handles line-folding, VALUE=DATE, timezones,
 * which hand-rolled regex misses on Booking.com / LekkeSlaap feeds) and
 * ical-generator for correct escaping on the way out.
 */
const nodeIcal = require('node-ical');
const icalGenerator = require('ical-generator').default || require('ical-generator');

// Airbnb/other generic block titles that carry no real guest name.
const GENERIC_TITLES = ['reserved', 'airbnb (not available)', 'not available',
  'blocked', 'closed - not available', 'unavailable', 'airbnb', 'booking.com',
  'closed', 'external booking'];

/** Parse iCal text → [{ uid, start, end, summary, description, resCode }]. */
function parseFeed(text) {
  const data = nodeIcal.parseICS(text);
  const events = [];
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (!v || v.type !== 'VEVENT') continue;
    if (!v.start || !v.end) continue;
    events.push({
      uid: (v.uid || '').toString().trim(),
      start: dateFromIcal(v.start),
      end: dateFromIcal(v.end),
      summary: (v.summary || '').toString().trim(),
      description: (v.description || '').toString(),
      resCode: extractResCode(v),
    });
  }
  return events;
}

/** Airbnb reservation code (e.g. HMABC12345) from the event URL/description/uid. */
function extractResCode(v) {
  const hay = `${v.description || ''} ${v.uid || ''} ${v.summary || ''}`;
  const m = hay.match(/\b(H[A-Z0-9]{9})\b/);
  return m ? m[1] : '';
}

/** True if a summary is a generic block with no usable guest name. */
function isGenericTitle(summary) {
  const s = (summary || '').trim().toLowerCase();
  return s === '' || GENERIC_TITLES.indexOf(s) !== -1;
}

/**
 * Build the export .ics for a unit: one all-day VEVENT per confirmed booking,
 * blocking [checkIn, checkOut). Floating/cancelled bookings are never exported.
 * `excludeSource` lets a per-channel feed omit that channel's own bookings so we
 * never echo a channel's reservations back to itself.
 */
function buildFeed({ unitName, bookings, excludeSource, prodId }) {
  const cal = icalGenerator({
    name: `StaySync — ${unitName || 'Unit'}`,
    prodId: prodId || { company: 'StaySync', product: 'channel-manager' },
    ttl: 60 * 60, // suggest hourly refresh
  });
  bookings.forEach((b) => {
    if (b.status !== 'confirmed') return;
    if (excludeSource && b.source === excludeSource) return;
    cal.createEvent({
      id: `${b.id}@staysync`,
      start: dateOnly(b.checkIn),
      end: dateOnly(b.checkOut),
      allDay: true,
      summary: 'Reserved',
    });
  });
  return cal.toString();
}

/** Half-open overlap of [aStart,aEnd) and [bStart,bEnd). Back-to-back = no overlap. */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return dateOnly(aStart).getTime() < dateOnly(bEnd).getTime()
    && dateOnly(bStart).getTime() < dateOnly(aEnd).getTime();
}

/**
 * Normalize a booking date input to a stable date-only value (noon UTC).
 *  - 'YYYY-MM-DD' strings are parsed by their digits (no timezone involved).
 *  - Dates we already normalized (or Prisma returns) are noon-UTC → UTC getters.
 */
function dateOnly(input) {
  if (typeof input === 'string') {
    const m = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0));
  }
  const x = new Date(input);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), 12, 0, 0));
}

/**
 * Convert a date node-ical produced to our noon-UTC date-only value.
 * node-ical builds VALUE=DATE using the LOCAL constructor, so local getters
 * recover the exact calendar date regardless of the server's timezone.
 */
function dateFromIcal(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate(), 12, 0, 0));
}

module.exports = { parseFeed, buildFeed, overlaps, dateOnly, dateFromIcal, isGenericTitle, extractResCode };
