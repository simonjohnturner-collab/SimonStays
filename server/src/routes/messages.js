// Host side of guest messaging: per-booking conversations, saved (pre-typed)
// messages, and scheduled automatic messages. The guest side lives in
// routes/guestMessages.js; sending + scheduling logic in utils/messaging.js.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const messaging = require('../utils/messaging');
const offers = require('../utils/offers');
const changes = require('../utils/changes');
const { shownCheckOut, shownNights } = require('../utils/ical');
const { createInvite, tripGuestsOf } = require('../utils/tripInvites');

const router = express.Router();
router.use(authHost);

const iso = (d) => new Date(d).toISOString().slice(0, 10);
// Bookings this host owns: directly (manual/floating) or via the unit's property.
const owned = (hostId) => ({ OR: [{ hostId }, { unit: { property: { hostId } } }] });

function bookingSummary(b) {
  return {
    id: b.id, status: b.status, source: b.source, ref: b.ref || null,
    guestName: b.guestName || null, guestEmail: b.guestEmail || (b.guestAccount && b.guestAccount.email) || null,
    propertyId: b.unit?.propertyId || null, propertyName: b.unit?.property?.name || null, unitName: b.unit?.name || null,
    checkIn: iso(b.checkIn), checkOut: iso(shownCheckOut(b)),
    nights: shownNights(b), dayUse: !!b.dayUse,
    amountCents: b.quotedCents != null ? b.quotedCents : (b.totalCents != null ? b.totalCents : null),
    paidCents: b.amountPaidCents || 0, paid: !!b.paid,
    refundDueCents: b.refundDueCents, refundedAt: b.refundedAt, cancelledBy: b.cancelledBy || null,
    // Can the guest actually read messages (an email to copy to, or a shopfront account)?
    reachable: !!(b.guestEmail || b.guestAccountId),
  };
}
const SUMMARY_INCLUDE = { unit: { include: { property: true, pricingGroup: true } }, guestAccount: { select: { email: true } } };

async function loadOwnedBooking(req, res) {
  const b = await prisma.booking.findFirst({ where: { id: req.params.bookingId, ...owned(req.hostId) }, include: SUMMARY_INCLUDE });
  if (!b) res.status(404).json({ error: 'not_found' });
  return b;
}

// GET /messages/meta — the shortcuts a message body can use. `placeholders` stays
// for an admin site not yet redeployed (the static site deploys separately).
router.get('/meta', (req, res) => res.json({ placeholders: messaging.PLACEHOLDERS, shortcuts: messaging.SHORTCUTS }));

// GET /messages/unread — guest messages the host hasn't opened yet, one entry per
// conversation, newest first (for the bell).
router.get('/unread', async (req, res, next) => {
  try {
    const where = { hostId: req.hostId, sender: 'guest', readAt: null };
    const [count, rows] = await Promise.all([
      prisma.message.count({ where }),
      prisma.message.findMany({
        where, orderBy: { createdAt: 'desc' }, take: 100,
        select: {
          id: true, bookingId: true, body: true, createdAt: true,
          booking: { select: { guestName: true, status: true, unit: { select: { name: true, property: { select: { name: true } } } } } },
        },
      }),
    ]);
    const threads = new Map();
    for (const m of rows) {
      const t = threads.get(m.bookingId);
      if (t) { t.unread += 1; continue; }
      threads.set(m.bookingId, {
        bookingId: m.bookingId, latestId: m.id, unread: 1, body: m.body.slice(0, 120), createdAt: m.createdAt,
        guestName: m.booking.guestName || null, enquiry: m.booking.status === 'enquiry',
        propertyName: m.booking.unit?.property?.name || null, unitName: m.booking.unit?.name || null,
      });
    }
    res.json({ count, threads: [...threads.values()] });
  } catch (e) { next(e); }
});

// GET /messages/attachments/:id — a file on one of this host's messages. Its type
// was worked out from the file when it arrived, so a browser can show it safely.
router.get('/attachments/:id', async (req, res, next) => {
  try {
    const a = await prisma.messageAttachment.findFirst({ where: { id: req.params.id, message: { hostId: req.hostId } } });
    if (!a) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', a.contentType);
    res.set('Content-Disposition', `inline; filename="${a.filename.replace(/"/g, '')}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    res.send(Buffer.from(a.data));
  } catch (e) { next(e); }
});

// GET /messages/threads — every booking with a conversation, latest first.
router.get('/threads', async (req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: { ...owned(req.hostId), messages: { some: {} } },
      include: {
        ...SUMMARY_INCLUDE,
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { messages: { where: { sender: 'guest', readAt: null } } } },
      },
      take: 300,
    });
    const threads = bookings.map((b) => ({
      booking: bookingSummary(b),
      last: b.messages[0] ? { body: b.messages[0].body, sender: b.messages[0].sender, createdAt: b.messages[0].createdAt } : null,
      unread: b._count.messages,
    })).sort((a, b) => new Date(b.last.createdAt) - new Date(a.last.createdAt));
    res.json({ threads });
  } catch (e) { next(e); }
});

// GET /messages/recipients?q= — current and upcoming bookings to start a conversation with.
router.get('/recipients', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const where = {
      ...owned(req.hostId), unitId: { not: null },
      status: { in: ['confirmed', 'pending'] },
      checkOut: { gte: new Date(Date.now() - 14 * 864e5) },
    };
    if (q) {
      where.AND = [{ OR: [
        { guestName: { contains: q, mode: 'insensitive' } },
        { guestEmail: { contains: q, mode: 'insensitive' } },
        { ref: { contains: q, mode: 'insensitive' } },
        { resCode: { contains: q, mode: 'insensitive' } },
      ] }];
    }
    const bookings = await prisma.booking.findMany({ where, include: SUMMARY_INCLUDE, orderBy: { checkIn: 'asc' }, take: 40 });
    res.json({ bookings: bookings.map(bookingSummary) });
  } catch (e) { next(e); }
});

// GET /messages/booking/:bookingId — the conversation; marks the guest's messages read.
router.get('/booking/:bookingId', async (req, res, next) => {
  try {
    const b = await loadOwnedBooking(req, res); if (!b) return;
    const messages = await prisma.message.findMany({
      where: { bookingId: b.id }, orderBy: { createdAt: 'asc' },
      include: { schedule: { select: { name: true } }, offer: true, attachments: { select: { id: true, filename: true } } },
    });
    await prisma.message.updateMany({ where: { bookingId: b.id, sender: 'guest', readAt: null }, data: { readAt: new Date() } });
    const standard = await offers.standardQuote(b).catch(() => null);
    const sent = messages.filter((m) => m.offer).map((m) => m.offer);
    const invoices = sent.filter((o) => o.kind !== 'change');
    const latest = invoices[invoices.length - 1] || null;
    const invoiced = offers.conversationCents(sent);
    const rc = b.unit && b.unit.pricingGroup;
    res.json({
      booking: { ...bookingSummary(b), amountCents: invoiced != null ? invoiced : bookingSummary(b).amountCents },
      // The pricing sheet only compares fairly with an invoice for this one unit.
      standardCents: standard && !b.dayUse && !(latest && offers.staysOf(latest).length > 1) ? standard.totalCents : null,
      invoice: {
        blocked: offers.invoiceBlock(b),
        draftLines: offers.draftFor(latest, standard, b),
        validHours: offers.OFFER_HOURS,
      },
      change: {
        blocked: changes.changeBlock(b),
        validHours: offers.OFFER_HOURS,
        lateCents: rc ? rc.lateCheckOutCents || 0 : 0, earlyCents: rc ? rc.earlyCheckInCents || 0 : 0, cleanCents: rc ? rc.instayCleanCents || rc.cleaningCents || 0 : 0,
      },
      cancel: await changes.cancelQuote(b, 'host'),
      travellers: await tripGuestsOf(b.id),
      messages: messages.map((m) => ({
        id: m.id, sender: m.sender, body: m.body, createdAt: m.createdAt, readAt: m.readAt, authorName: m.authorName || null, scheduleId: m.scheduleId || null,
        emailedAt: m.emailedAt, scheduleName: m.schedule ? m.schedule.name : (m.scheduleId ? 'Scheduled message' : null),
        offer: m.offer ? offers.offerOut(m.offer, b) : null,
        attachments: m.attachments,
      })),
    });
  } catch (e) { next(e); }
});

// POST /messages/booking/:bookingId { body, scheduleId } — send a message to the
// guest now. With a scheduled message's id it counts as that message having gone,
// so the job won't send it again; if it already has, this is just an extra copy.
router.post('/booking/:bookingId', async (req, res, next) => {
  try {
    const b = await loadOwnedBooking(req, res); if (!b) return;
    const body = String((req.body || {}).body || '').trim();
    if (!body) return res.status(400).json({ error: 'empty', message: 'Type a message first.' });
    let scheduleId = null;
    if ((req.body || {}).scheduleId) {
      const s = await prisma.messageSchedule.findFirst({ where: { id: String(req.body.scheduleId), hostId: req.hostId }, select: { id: true } });
      if (s && !(await prisma.message.findFirst({ where: { scheduleId: s.id, bookingId: b.id }, select: { id: true } }))) scheduleId = s.id;
    }
    const r = await messaging.sendHostMessage(b.id, body, { scheduleId });
    if (!r.ok) return res.status(400).json({ error: r.reason || 'send_failed' });
    res.status(201).json({ message: r.message, emailed: !!r.message.emailedAt });
  } catch (e) { next(e); }
});

// POST /messages/booking/:bookingId/invite — a link that adds a friend to this trip.
router.post('/booking/:bookingId/invite', async (req, res, next) => {
  try {
    const b = await loadOwnedBooking(req, res); if (!b) return;
    if (b.status === 'cancelled') return res.status(400).json({ error: 'cancelled', message: 'This booking has been cancelled.' });
    res.status(201).json(await createInvite(b.id, 'host'));
  } catch (e) { next(e); }
});

// DELETE /messages/booking/:bookingId/travellers/:accountId — take a friend off this trip.
router.delete('/booking/:bookingId/travellers/:accountId', async (req, res, next) => {
  try {
    const b = await loadOwnedBooking(req, res); if (!b) return;
    await prisma.tripGuest.deleteMany({ where: { bookingId: b.id, guestAccountId: req.params.accountId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /messages/booking/:bookingId/invoice { lines, note } — send a custom-priced invoice.
router.post('/booking/:bookingId/invoice', async (req, res, next) => {
  try {
    const b = await loadOwnedBooking(req, res); if (!b) return;
    const r = await offers.sendOffer(b, req.body || {});
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    res.status(201).json({ offer: offers.offerOut(r.offer, b), emailed: !!r.message.emailedAt });
  } catch (e) { next(e); }
});

// POST /messages/booking/:bookingId/change { lines, note } — invoice a change to a confirmed booking.
router.post('/booking/:bookingId/change', async (req, res, next) => {
  try {
    const b = await loadOwnedBooking(req, res); if (!b) return;
    const r = await changes.sendChange(b, req.body || {});
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    res.status(201).json({ offer: offers.offerOut(r.offer, b), applied: r.applied, emailed: !!r.message.emailedAt });
  } catch (e) { next(e); }
});

// POST /messages/booking/:bookingId/offers/:offerId/mark-paid — an EFT arrived for a change invoice.
router.post('/booking/:bookingId/offers/:offerId/mark-paid', async (req, res, next) => {
  try {
    const b = await loadOwnedBooking(req, res); if (!b) return;
    const r = await changes.markChangePaid(b, req.params.offerId);
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /messages/booking/:bookingId/cancel { refundCents } — cancel; the refund defaults to the policy's.
router.post('/booking/:bookingId/cancel', async (req, res, next) => {
  try {
    const b = await loadOwnedBooking(req, res); if (!b) return;
    const raw = (req.body || {}).refundCents;
    const r = await changes.cancelBooking(b, { by: 'host', refundCents: raw == null ? null : Number(raw) });
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    res.json({ ok: true, refundCents: r.refundCents });
  } catch (e) { next(e); }
});

// POST /messages/booking/:bookingId/refund { refundCents } — the host has paid the refund back.
router.post('/booking/:bookingId/refund', async (req, res, next) => {
  try {
    const b = await loadOwnedBooking(req, res); if (!b) return;
    const r = await changes.markRefunded(b, Number((req.body || {}).refundCents));
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /messages/booking/:bookingId/close — turn down an enquiry; its invoice can't be paid after this.
router.post('/booking/:bookingId/close', async (req, res, next) => {
  try {
    const b = await loadOwnedBooking(req, res); if (!b) return;
    if (b.status !== 'enquiry') return res.status(400).json({ error: 'not_enquiry', message: 'Only an enquiry can be closed here.' });
    await prisma.booking.update({ where: { id: b.id }, data: { status: 'cancelled' } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /messages/render { bookingId, body } — fill placeholders for a booking (compose preview).
router.post('/render', async (req, res, next) => {
  try {
    const { bookingId, body } = req.body || {};
    const b = await prisma.booking.findFirst({ where: { id: bookingId || '', ...owned(req.hostId) }, include: messaging.BOOKING_INCLUDE });
    if (!b) return res.status(404).json({ error: 'not_found' });
    res.json({ body: messaging.render(body, b) });
  } catch (e) { next(e); }
});

// ---- Saved messages ----

router.get('/templates', async (req, res, next) => {
  try {
    const templates = await prisma.messageTemplate.findMany({ where: { hostId: req.hostId }, orderBy: { name: 'asc' } });
    res.json({ templates });
  } catch (e) { next(e); }
});

router.post('/templates', async (req, res, next) => {
  try {
    const { name, body } = req.body || {};
    if (!String(name || '').trim() || !String(body || '').trim()) return res.status(400).json({ error: 'name_and_body_required' });
    const template = await prisma.messageTemplate.create({ data: { hostId: req.hostId, name: String(name).trim(), body: String(body) } });
    res.status(201).json({ template });
  } catch (e) { next(e); }
});

router.patch('/templates/:id', async (req, res, next) => {
  try {
    const t = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, hostId: req.hostId } });
    if (!t) return res.status(404).json({ error: 'not_found' });
    const data = {};
    if ('name' in req.body && String(req.body.name).trim()) data.name = String(req.body.name).trim();
    if ('body' in req.body) data.body = String(req.body.body || '');
    const template = await prisma.messageTemplate.update({ where: { id: t.id }, data });
    res.json({ template });
  } catch (e) { next(e); }
});

router.delete('/templates/:id', async (req, res, next) => {
  try {
    const t = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, hostId: req.hostId }, include: { schedules: { select: { id: true } } } });
    if (!t) return res.status(404).json({ error: 'not_found' });
    // A schedule using this message keeps working: freeze the text onto it.
    if (t.schedules.length) {
      await prisma.messageSchedule.updateMany({ where: { templateId: t.id, body: null }, data: { body: t.body } });
    }
    await prisma.messageTemplate.delete({ where: { id: t.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Scheduled messages ----

const ANCHORS = ['confirmed', 'check_in', 'check_out'];

async function scheduleData(hostId, b, partial) {
  const data = {};
  if (!partial || 'name' in b) {
    const name = String(b.name || '').trim();
    if (!name) throw Object.assign(new Error('Give the scheduled message a name.'), { status: 400 });
    data.name = name;
  }
  if (!partial || 'anchor' in b) {
    if (!ANCHORS.includes(b.anchor)) throw Object.assign(new Error('Pick when to send it.'), { status: 400 });
    data.anchor = b.anchor;
  }
  if (!partial || 'offsetDays' in b) data.offsetDays = Math.max(-365, Math.min(365, Math.round(Number(b.offsetDays) || 0)));
  if (!partial || 'offsetMinutes' in b) data.offsetMinutes = Math.max(0, Math.min(10080, Math.round(Number(b.offsetMinutes) || 0)));
  if (!partial || 'sendTime' in b) {
    const t = String(b.sendTime || '10:00');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw Object.assign(new Error('Send time must be HH:MM.'), { status: 400 });
    data.sendTime = t;
  }
  if (!partial || 'propertyIds' in b) {
    const ids = Array.isArray(b.propertyIds) ? b.propertyIds : [];
    const mine = ids.length ? await prisma.property.findMany({ where: { hostId, id: { in: ids } }, select: { id: true } }) : [];
    data.propertyIds = mine.map((p) => p.id);
  }
  if ('noProperties' in b) {
    data.noProperties = !!b.noProperties;
    if (data.noProperties) data.propertyIds = [];
  }
  if (!partial || 'templateId' in b) {
    if (b.templateId) {
      const t = await prisma.messageTemplate.findFirst({ where: { id: b.templateId, hostId }, select: { id: true } });
      if (!t) throw Object.assign(new Error('That saved message no longer exists.'), { status: 400 });
      data.templateId = t.id;
    } else data.templateId = null;
  }
  if (!partial || 'body' in b) data.body = String(b.body || '').trim() || null;
  if ('active' in b) data.active = !!b.active;
  return data;
}

const withCounts = { _count: { select: { messages: true } } };
const scheduleOut = (s) => ({ ...s, sentCount: s._count ? s._count.messages : 0, _count: undefined });

router.get('/schedules', async (req, res, next) => {
  try {
    const schedules = await prisma.messageSchedule.findMany({ where: { hostId: req.hostId }, orderBy: { createdAt: 'asc' }, include: withCounts });
    res.json({ schedules: schedules.map(scheduleOut) });
  } catch (e) { next(e); }
});

router.post('/schedules', async (req, res, next) => {
  try {
    const data = await scheduleData(req.hostId, req.body || {}, false);
    if (!data.templateId && !data.body) return res.status(400).json({ error: 'no_message', message: 'Pick a saved message or type one.' });
    const schedule = await prisma.messageSchedule.create({ data: { ...data, hostId: req.hostId }, include: withCounts });
    res.status(201).json({ schedule: scheduleOut(schedule) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: 'invalid', message: e.message });
    next(e);
  }
});

router.patch('/schedules/:id', async (req, res, next) => {
  try {
    const s = await prisma.messageSchedule.findFirst({ where: { id: req.params.id, hostId: req.hostId } });
    if (!s) return res.status(404).json({ error: 'not_found' });
    const data = await scheduleData(req.hostId, req.body || {}, true);
    const templateId = 'templateId' in data ? data.templateId : s.templateId;
    const body = 'body' in data ? data.body : s.body;
    if (!templateId && !body) return res.status(400).json({ error: 'no_message', message: 'Pick a saved message or type one.' });
    const schedule = await prisma.messageSchedule.update({ where: { id: s.id }, data, include: withCounts });
    res.json({ schedule: scheduleOut(schedule) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: 'invalid', message: e.message });
    next(e);
  }
});

router.delete('/schedules/:id', async (req, res, next) => {
  try {
    const s = await prisma.messageSchedule.findFirst({ where: { id: req.params.id, hostId: req.hostId } });
    if (!s) return res.status(404).json({ error: 'not_found' });
    await prisma.messageSchedule.delete({ where: { id: s.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
