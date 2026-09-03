/**
 * Parse an Airbnb reservation email into { resCode, guestName, phoneLast4 }.
 * The reservation code is the join key back to the iCal event; the name is what
 * Airbnb's iCal omits. Works on native or forwarded ("FW:") mail.
 */

function parseAirbnbEmail({ subject = '', body = '' } = {}) {
  const raw = `${subject}\n${body}`.replace(/\r/g, '');
  const flat = raw.replace(/\s+/g, ' ').trim();

  const resCode = (flat.match(/\b(H[A-Z0-9]{9})\b/) || [])[1] || null;
  const phoneLast4 = (flat.match(/Last 4 Digits\)?\s*:?\s*(\d{4})/i) || [])[1] || null;
  const guestName = extractGuestName(subject) || extractGuestName(flat) || null;

  return { resCode, guestName, phoneLast4 };
}

// Best-effort name extraction from common Airbnb subject/body phrasings.
function extractGuestName(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  // Unicode-aware: \p{Lu} = an uppercase letter, \p{L} = any letter (handles
  // accented/international names like "Vibeke Røre", "José", "Zoë").
  const patterns = [
    /(?:Reservation|Booking)\s+confirmed[^\p{L}]+(\p{Lu}[\p{L}'’.\-]*(?:\s+\p{Lu}[\p{L}'’.\-]*){0,2})\s+(?:arrives|will\s+arrive|checks?\s+in|\()/u,
    /\b(\p{Lu}[\p{L}'’.\-]*(?:\s+\p{Lu}[\p{L}'’.\-]*){0,2})\s+arrives\b/u,
    /Instant\s+book(?:ing)?\s+confirmed[^\p{L}]+(\p{Lu}[\p{L}'’.\-]*(?:\s+\p{Lu}[\p{L}'’.\-]*){0,2})/u,
    /Your\s+reservation\s+with\s+(\p{Lu}[\p{L}'’.\-]*(?:\s+\p{Lu}[\p{L}'’.\-]*){0,2})/u,
    /\bfrom\s+(\p{Lu}[\p{L}'’.\-]*(?:\s+\p{Lu}[\p{L}'’.\-]*){0,1})\s+(?:has\s+)?(?:arriv|check)/u,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1] && !/^(Reservation|Booking|Airbnb|Your|Guest|Check)$/i.test(m[1])) return m[1].trim();
  }
  return '';
}

module.exports = { parseAirbnbEmail, extractGuestName };
