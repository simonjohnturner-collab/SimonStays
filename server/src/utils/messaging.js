// Guest messaging: placeholder rendering, sending a host message to a booking's
// guest (in-app on the shopfront + an email copy), and the scheduled-message job.
//
// Message bodies may contain shortcuts in square brackets, filled per booking at
// send time: [Guest Name], [Check In Time] and so on (see SHORTCUTS). Capitals,
// spaces and hyphens don't matter. The older {guestName} form still works, so
// messages saved before the change keep filling in. A shortcut with no value for
// the booking renders blank; anything else in brackets is left as typed.
const prisma = require('../lib/prisma');
const { sendMail } = require('./mailer');
const { folderLink } = require('./documents');

// SAST is UTC+2 year-round (no DST).
const SAST_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 864e5;
const MINUTE_MS = 6e4;
// How far back the job will still send a message whose time has passed (e.g.
// the server was asleep). Older than this is skipped rather than sent late.
const CATCH_UP_MS = 24 * 60 * 60 * 1000;
const SUPPORT_EMAIL = 'support@simonstays.co.za';
// How long the host waits on an email before it carries on in the background.
const EMAIL_WAIT_MS = 5000;

const SHORTCUTS = [
  { key: 'guestName', label: 'Guest Name', hint: 'The guest’s full name' },
  { key: 'firstName', label: 'First Name', hint: 'The guest’s first name' },
  { key: 'property', label: 'Property', hint: 'Property name' },
  { key: 'unit', label: 'Unit', hint: 'Unit name or number' },
  { key: 'address', label: 'Address', hint: 'Property address' },
  { key: 'checkIn', label: 'Check In', hint: 'Check-in date' },
  { key: 'checkOut', label: 'Check Out', hint: 'Check-out date' },
  { key: 'checkInTime', label: 'Check In Time', hint: 'Time check-in opens' },
  { key: 'checkOutTime', label: 'Check Out Time', hint: 'Time to check out by' },
  { key: 'nights', label: 'Nights', hint: 'Number of nights' },
  { key: 'ref', label: 'Ref', hint: 'Booking reference' },
  { key: 'wifiName', label: 'Wifi Name', hint: 'The unit’s wifi network' },
  { key: 'wifiPassword', label: 'Wifi Password', hint: 'The unit’s wifi password' },
  { key: 'accessCode', label: 'Access Code', hint: 'The booking’s door code' },
  { key: 'parking', label: 'Parking', hint: 'Parking notes' },
  { key: 'hostName', label: 'Host Name', hint: 'Your name' },
  { key: 'documentsLink', label: 'Documents Link', hint: 'Link to this property’s shared documents' },
  { key: 'earlyCheckInFee', label: 'Early Check In Fee', hint: 'From the unit’s pricing' },
  { key: 'lateCheckOutFee', label: 'Late Check Out Fee', hint: 'From the unit’s pricing' },
  { key: 'cleaningFee', label: 'Cleaning Fee', hint: 'Unit clean, from the unit’s pricing' },
  { key: 'instayCleanFee', label: 'Instay Clean Fee', hint: 'Instay clean, from the unit’s pricing' },
  { key: 'extraMattressFee', label: 'Extra Mattress Fee', hint: 'From the unit’s pricing' },
  { key: 'breakageDeposit', label: 'Breakage Deposit', hint: 'Refundable, from the unit’s pricing' },
];
const PLACEHOLDERS = SHORTCUTS.map((s) => s.key);

const shortcutId = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const SHORTCUT_KEYS = new Map(SHORTCUTS.map((s) => [shortcutId(s.key), s.key]));

// Booking include that carries everything the placeholders need.
const BOOKING_INCLUDE = { unit: { include: { pricingGroup: true, property: { include: { host: { select: { name: true } } } } } } };

const { shownCheckOut, shownNights } = require('./ical');
const iso = (d) => new Date(d).toISOString().slice(0, 10);
function fmtDay(d) {
  try { return new Date(d).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  catch (e) { return iso(d); }
}
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }

function valuesFor(b) {
  const u = b.unit || {};
  const p = u.property || {};
  const g = u.pricingGroup || {};
  // A fee of 0 means none is set on the rate card, not that it's free.
  const fee = (cents) => (cents ? fmtRand(cents) : '');
  return {
    guestName: b.guestName || '',
    firstName: firstName(b.guestName),
    property: p.name || '',
    unit: u.name || '',
    address: p.address || '',
    checkIn: fmtDay(b.checkIn),
    checkOut: fmtDay(shownCheckOut(b)),
    checkInTime: u.checkInTime || p.checkInTime || '15:00',
    checkOutTime: u.checkOutTime || p.checkOutTime || '10:00',
    nights: String(shownNights(b)),
    ref: b.ref || '',
    wifiName: u.wifiName || '',
    wifiPassword: u.wifiPassword || '',
    accessCode: b.accessCode || '',
    parking: u.parkingNotes || p.parkingNotes || '',
    hostName: (p.host && p.host.name) || 'SimonStays',
    documentsLink: p.id ? folderLink(p.id) : '',
    earlyCheckInFee: fee(g.earlyCheckInCents),
    lateCheckOutFee: fee(g.lateCheckOutCents),
    cleaningFee: fee(g.cleaningCents),
    instayCleanFee: fee(g.instayCleanCents || g.cleaningCents),
    extraMattressFee: fee(g.mattressCents),
    breakageDeposit: fee(g.breakageDepositCents),
  };
}

function render(body, booking) {
  const v = valuesFor(booking);
  return String(body || '').replace(/\[([^[\]\n]+)\]|\{(\w+)\}/g, (m, square, curly) => {
    const key = SHORTCUT_KEYS.get(shortcutId(square || curly));
    return key ? v[key] : m;
  });
}

// Where the guest can read their messages (the shopfront opens its inbox on ?messages).
function inboxUrl() {
  const base = (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
  return `${base}/?messages`;
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// A message as email HTML, with any web links clickable.
const bodyHtml = (s) => escHtml(s).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}" style="color:#1a7a3a">${url}</a>`);

// Email a copy to the guest and any friends on the trip. Anything about money only
// goes to the guest who booked. Answers whether the guest who booked got theirs.
async function emailGuest(booking, body, offer = null, bookerOnly = false, notice = null) {
  if (!offer && !bookerOnly) {
    // Only to a proved address: a mistyped one shouldn't get the door code.
    const friends = await prisma.tripGuest.findMany({ where: { bookingId: booking.id, account: { emailVerifiedAt: { not: null } } }, select: { account: { select: { email: true } } } });
    await Promise.all(friends.map((f) => emailOne(f.account.email, booking, body, null, notice))).catch(() => {});
  }
  return emailOne(booking.guestEmail || (booking.guestAccount && booking.guestAccount.email), booking, body, offer, notice);
}

async function emailOne(to, booking, body, offer = null, notice = null) {
  if (!to) return false;
  if (notice) return emailNotice(to, booking, body, notice);
  const place = [booking.unit?.property?.name, booking.unit?.name && `Unit ${booking.unit.name}`].filter(Boolean).join(' · ') || 'your stay';
  const link = inboxUrl();
  if (offer) return emailInvoiceOffer(to, place, body, offer, link);
  return sendMail({
    to,
    subject: `New message about your stay at ${place}`,
    text: `${body}\n\n—\nTo reply, open your messages on SimonStays: ${link}\nOr reply to this email to reach ${SUPPORT_EMAIL}.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#1d2433">` +
      `<p style="white-space:pre-line">${bodyHtml(body)}</p>` +
      `<p><a href="${link}" style="display:inline-block;background:#1a7a3a;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Reply on SimonStays</a></p>` +
      `<p style="color:#6b7280;font-size:13px">About your stay at <b>${escHtml(place)}</b>. ` +
      `You can also reply to this email to reach ${SUPPORT_EMAIL}.</p></div>`,
  }).catch(() => false);
}

const NOTICES = {
  confirmed: 'Your SimonStays booking is confirmed',
  changed: 'Your SimonStays booking has changed',
  cancelled: 'Your SimonStays booking is cancelled',
  refund: 'About your SimonStays refund',
  invoice: 'Your SimonStays payment invoice',
};

// Guests we take bookings for directly, on a stay that isn't over. Airbnb and the
// other channels send their own guests these emails.
function noticeable(b) {
  return ['website', 'manual'].includes(b.source)
    && new Date(b.checkOut).getTime() >= Date.now() - DAY_MS
    && !!(b.guestEmail || b.guestAccountId || b.guestAccount);
}

// A booking email with its own subject and the stay's details, rather than the
// general "new message" copy.
function emailNotice(to, b, body, kind) {
  const v = valuesFor(b);
  const live = kind === 'confirmed' || kind === 'changed';
  const rows = [
    ['Reference', v.ref],
    ['Where', [v.property, v.unit && `Unit ${v.unit}`].filter(Boolean).join(' · ')],
    live && ['Address', v.address],
    ['Check-in', live ? `${v.checkIn} from ${v.checkInTime}` : v.checkIn],
    !b.dayUse && ['Check-out', live ? `${v.checkOut} by ${v.checkOutTime}` : v.checkOut],
    !b.dayUse && ['Nights', v.nights],
  ].filter((r) => r && r[1]);
  const link = inboxUrl();
  return sendMail({
    to,
    subject: `${NOTICES[kind]}${b.ref ? ` · ${b.ref}` : ''}`,
    text: `${body}\n\n${rows.map(([k, val]) => `${k}: ${val}`).join('\n')}\n\n—\nQuestions? Reply to this email, or open your messages on SimonStays: ${link}`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#1d2433">` +
      `<p style="font-size:18px;font-weight:700;margin:0 0 12px">${escHtml(NOTICES[kind])}</p>` +
      `<p style="white-space:pre-line">${bodyHtml(body)}</p>` +
      `<table style="width:100%;max-width:480px;border-collapse:collapse;margin:12px 0">${rows.map(([k, val]) => `<tr><td style="padding:5px 12px 5px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escHtml(k)}</td><td style="padding:5px 0;font-weight:600">${escHtml(val)}</td></tr>`).join('')}</table>` +
      `<p><a href="${link}" style="display:inline-block;background:#1a7a3a;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Open your messages</a></p>` +
      `<p style="color:#6b7280;font-size:13px">Questions? Reply to this email to reach ${SUPPORT_EMAIL}.</p></div>`,
  }).catch(() => false);
}

// Email the booker a notice without adding to the conversation. `body` may hold shortcuts.
function emailBookingNotice(b, kind, body) {
  if (!noticeable(b)) return Promise.resolve(false);
  return emailOne(b.guestEmail || (b.guestAccount && b.guestAccount.email), b, render(body, b), null, kind);
}

const fmtRand = (c) => `${c < 0 ? '-' : ''}R${(Math.abs(c) / 100).toFixed(2)}`;

// The guest's copy of an invoice sent in a conversation, with its pay link.
function emailInvoiceOffer(to, place, body, offer, inbox) {
  const { offerLink } = require('./offers');
  const pay = offerLink(offer);
  const rows = offer.lines.map((l) => `<tr><td style="padding:6px 0">${escHtml(l.description)}</td><td style="padding:6px 0;text-align:right;white-space:nowrap">${fmtRand(l.amountCents)}</td></tr>`).join('');
  return sendMail({
    to,
    subject: `Your invoice for ${place}: ${fmtRand(offer.totalCents)}`,
    text: `${body}\n\n${offer.lines.map((l) => `${l.description}: ${fmtRand(l.amountCents)}`).join('\n')}\nTotal: ${fmtRand(offer.totalCents)}\n\nView and pay: ${pay}\n\n—\nTo reply, open your messages on SimonStays: ${inbox}\nOr reply to this email to reach ${SUPPORT_EMAIL}.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#1d2433">` +
      `<p style="white-space:pre-line">${bodyHtml(body)}</p>` +
      `<table style="width:100%;max-width:480px;border-collapse:collapse;margin:12px 0">${rows}` +
      `<tr><td style="padding:8px 0;border-top:1px solid #d9dee3;font-weight:700">Total</td><td style="padding:8px 0;border-top:1px solid #d9dee3;font-weight:700;text-align:right;white-space:nowrap">${fmtRand(offer.totalCents)}</td></tr></table>` +
      `<p><a href="${pay}" style="display:inline-block;background:#1a7a3a;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">View invoice &amp; pay</a></p>` +
      `<p style="color:#6b7280;font-size:13px">About your stay at <b>${escHtml(place)}</b>. Your dates aren't held until this is paid. To reply, use <a href="${inbox}">your messages on SimonStays</a>.</p></div>`,
  }).catch(() => false);
}

function hostIdOf(b) { return b.hostId || (b.unit && b.unit.property ? b.unit.property.hostId : null); }

// Send a host → guest message on a booking. `body` is rendered here, so it may
// still contain placeholders. With `scheduleId`, a repeat for the same booking
// is refused by the unique constraint and returns { duplicate: true }.
async function sendHostMessage(bookingOrId, body, { scheduleId = null, offer = null, bookerOnly = false, notice = null, noEmail = false } = {}) {
  const b = typeof bookingOrId === 'string' || !bookingOrId.unit
    ? await prisma.booking.findUnique({ where: { id: bookingOrId.id || bookingOrId }, include: { ...BOOKING_INCLUDE, guestAccount: { select: { email: true } } } })
    : bookingOrId;
  if (!b) return { ok: false, reason: 'not_found' };
  const text = render(body, b).trim();
  if (!text) return { ok: false, reason: 'empty' };
  let message;
  try {
    message = await prisma.message.create({ data: { hostId: hostIdOf(b), bookingId: b.id, sender: 'host', body: text, scheduleId, offerId: offer ? offer.id : null, bookerOnly: bookerOnly || !!offer } });
  } catch (e) {
    if (e.code === 'P2002') return { ok: false, duplicate: true };
    throw e;
  }
  if (noEmail) return { ok: true, message };
  // The message is saved, so a slow mail server mustn't hold up the host's screen:
  // wait briefly, and let a slower email finish on its own.
  const emailing = emailGuest(b, text, offer, bookerOnly, notice)
    .then((sent) => (sent ? prisma.message.update({ where: { id: message.id }, data: { emailedAt: new Date() } }) : null))
    .catch((e) => { console.error('[messaging] email failed', e.message); return null; });
  let timer;
  const emailed = await Promise.race([emailing, new Promise((resolve) => { timer = setTimeout(resolve, EMAIL_WAIT_MS, null); })]);
  clearTimeout(timer);
  if (emailed) message = emailed;
  return { ok: true, message };
}

// The text a schedule sends: its saved message's current text, else its own.
function scheduleBody(s) { return (s.template && s.template.body) || s.body || ''; }

// When a schedule is due for a booking (UTC Date), or null if it never is.
function dueAt(s, b) {
  if (s.anchor === 'confirmed') return b.confirmedAt ? new Date(new Date(b.confirmedAt).getTime() + (s.offsetMinutes || 0) * MINUTE_MS) : null;
  const anchorDate = s.anchor === 'check_out' ? shownCheckOut(b) : b.checkIn;
  const [y, m, d] = iso(anchorDate).split('-').map(Number);
  const [hh, mm] = String(s.sendTime || '10:00').split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d + (s.offsetDays || 0), hh || 0, mm || 0) - SAST_MS);
}

function appliesTo(s, b) {
  if (s.noProperties) return false;
  const ids = Array.isArray(s.propertyIds) ? s.propertyIds : [];
  return !ids.length || (b.unit && ids.includes(b.unit.propertyId));
}

// Only bookings someone can actually read messages for: confirmed, on a unit,
// with a guest email or a linked shopfront account.
const reachable = { status: 'confirmed', unitId: { not: null }, OR: [{ guestEmail: { not: null } }, { guestAccountId: { not: null } }] };

// Send every due scheduled message. Each (schedule, booking) pair sends once:
// due within the catch-up window, and never for a time before the schedule existed.
async function runSchedules(now = new Date()) {
  const schedules = await prisma.messageSchedule.findMany({ where: { active: true }, include: { template: true } });
  const out = { schedules: schedules.length, sent: 0, failed: 0 };
  for (const s of schedules) {
    const where = { ...reachable, unit: { property: { hostId: s.hostId } } };
    if (s.anchor === 'confirmed') {
      where.confirmedAt = { gte: new Date(now.getTime() - (s.offsetMinutes || 0) * MINUTE_MS - CATCH_UP_MS) };
    } else {
      // Anchor dates whose send time could fall inside [now − catch-up, now].
      const field = s.anchor === 'check_out' ? 'checkOut' : 'checkIn';
      const shift = (s.offsetDays || 0) * DAY_MS;
      where[field] = { gte: new Date(now.getTime() - shift - CATCH_UP_MS - 2 * DAY_MS), lte: new Date(now.getTime() - shift + 2 * DAY_MS) };
    }
    where.NOT = { messages: { some: { scheduleId: s.id } } };
    const bookings = await prisma.booking.findMany({ where, include: { ...BOOKING_INCLUDE, guestAccount: { select: { email: true } } } });
    const floor = Math.max(now.getTime() - CATCH_UP_MS, new Date(s.createdAt).getTime());
    for (const b of bookings) {
      if (!appliesTo(s, b)) continue;
      const due = dueAt(s, b);
      if (!due || due.getTime() > now.getTime() || due.getTime() < floor) continue;
      try {
        const r = await sendHostMessage(b, scheduleBody(s), { scheduleId: s.id });
        if (r.ok) out.sent++;
      } catch (e) { out.failed++; console.error('[messages] schedule send failed', s.id, b.id, e.message); }
    }
  }
  return out;
}

// Fire this host's "as soon as booked" schedules for one booking now.
async function runConfirmedSchedules(booking) {
  const hostId = hostIdOf(booking);
  if (!hostId || !booking.unit || !(booking.guestEmail || booking.guestAccountId)) return 0;
  const schedules = await prisma.messageSchedule.findMany({ where: { hostId, active: true, anchor: 'confirmed' }, include: { template: true } });
  let sent = 0;
  for (const s of schedules) {
    if (!appliesTo(s, booking) || s.offsetMinutes > 0) continue; // a delayed one waits for the job
    const r = await sendHostMessage(booking, scheduleBody(s), { scheduleId: s.id });
    if (r.ok) sent++;
  }
  return sent;
}

module.exports = {
  PLACEHOLDERS, SHORTCUTS, BOOKING_INCLUDE, render, sendHostMessage, runSchedules, runConfirmedSchedules,
  dueAt, appliesTo, scheduleBody, inboxUrl, hostIdOf, noticeable, emailBookingNotice,
};
