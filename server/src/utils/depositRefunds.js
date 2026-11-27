// Refunding a held breakage deposit, from the admin portal's Refunds tab. A full
// refund is started, then approved by retyping its amount, then paid: a card
// payment is sent back through Paygate (PayHost), an EFT is paid by hand and
// marked paid with its bank reference.
//
// A reduced refund (something kept back, with a reason) is instead sent to the
// guest to agree, from a private link. When they agree it is approved and, if it
// can go back to their card, sent straight away; an EFT waits to be paid by hand.
// If they don't agree the deposit stays held and SimonStays is told.
//
// Sending to Paygate never repeats by itself. The refund is marked 'check' before
// the request goes out, so if the reply is unclear (or the server stops mid-call)
// it waits for someone to confirm with Paygate whether it went through.
const prisma = require('../lib/prisma');
const messaging = require('./messaging');
const paygate = require('./paygate');
const { shownCheckOut } = require('./ical');

const { sendMail } = require('./mailer');
const { depositLink } = require('./guestThread');

const ADMIN_EMAIL = process.env.REFUNDS_ALERT_EMAIL || 'support@simonstays.co.za';
const WAIT_DAYS = 7; // nothing is paid until this long after checkout
const SAST_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const rand = (c) => `R${(c / 100).toFixed(2)}`;
const paidOn = (b) => (b.amountPaidCents != null ? b.amountPaidCents : (b.paid ? b.totalCents || 0 : 0));
const dueOn = (b) => iso(new Date(shownCheckOut(b)).getTime() + WAIT_DAYS * DAY_MS);
const today = (now) => iso(now.getTime() + SAST_MS);
// What can go back: the deposit, or what was actually paid if that's less.
const refundableOf = (b) => Math.min(b.depositCents || 0, paidOn(b));

const INCLUDE = {
  unit: { include: { property: { select: { name: true, hostId: true } } } },
  payments: { where: { status: 'COMPLETE' } },
  depositRefund: { include: { files: { select: { id: true, filename: true, contentType: true, sizeBytes: true }, orderBy: { createdAt: 'asc' } } } },
};

// Paygate (2026-11-12): a card payment can be refunded for 6 months. We stop a few
// days short so a refund is never sent on the last day and refused.
const CARD_REFUND_MONTHS = 6;
const CARD_REFUND_MARGIN_DAYS = 3;
function stillRefundable(p, now = new Date()) {
  const last = new Date(p.createdAt);
  last.setMonth(last.getMonth() + CARD_REFUND_MONTHS);
  return now.getTime() < last.getTime() - CARD_REFUND_MARGIN_DAYS * DAY_MS;
}

// Card payments a deposit could go back to: Paygate payments with a transaction ID.
function cardPayments(payments) {
  const sim = paygate.mode() === 'simulate';
  return payments.filter((p) => (p.provider === 'paygate' && p.raw && p.raw.TRANSACTION_ID) || (sim && p.provider === 'simulate'));
}
// The one to refund: still inside Paygate's 6 months, the largest (the deposit is
// charged with the stay, not the balance).
function cardPaymentOf(payments, now = new Date()) {
  const ok = cardPayments(payments).filter((p) => stillRefundable(p, now));
  return ok.sort((a, b) => b.amountCents - a.amountCents)[0] || null;
}
const txIdOf = (p) => (p && p.raw && p.raw.TRANSACTION_ID ? String(p.raw.TRANSACTION_ID) : p && p.provider === 'simulate' ? `SIM-${p.id}` : null);

// A booking's completed payments, or its invoice's when it's an invoice's extra unit.
async function paymentsOf(b) {
  const own = await prisma.payment.findMany({ where: { bookingId: b.id, status: 'COMPLETE' } });
  if (own.length || !b.sourceOfferId) return own;
  return prisma.payment.findMany({ where: { offerId: b.sourceOfferId, status: 'COMPLETE' } });
}

// Every deposit still held, and every refund already under way or paid. An invoice's
// extra units hold no payments of their own, so those are looked up by the invoice.
async function listRefunds({ hostId } = {}, now = new Date()) {
  const where = { depositCents: { gt: 0 }, OR: [{ status: 'confirmed', depositStatus: 'held' }, { depositRefund: { isNot: null } }] };
  if (hostId) where.AND = [{ OR: [{ hostId }, { unit: { property: { hostId } } }] }];
  const bookings = await prisma.booking.findMany({ where, include: INCLUDE, orderBy: { checkOut: 'asc' } });
  const offerIds = bookings.map((b) => b.sourceOfferId).filter(Boolean);
  const offerPayments = offerIds.length ? await prisma.payment.findMany({ where: { offerId: { in: offerIds }, status: 'COMPLETE' } }) : [];
  return bookings.map((b) => {
    const pays = b.payments.length ? b.payments : offerPayments.filter((p) => p.offerId === b.sourceOfferId);
    const card = pays[0];
    const toCard = cardPaymentOf(pays, now);
    return {
      bookingId: b.id, ref: b.ref || null,
      hostId: b.hostId || b.unit?.property?.hostId || null,
      property: b.unit?.property?.name || null, unit: b.unit?.name || null,
      guestName: b.guestName || null, guestEmail: b.guestEmail || null, guestPhone: b.guestPhone || null,
      checkOut: iso(shownCheckOut(b)), dueOn: dueOn(b), due: today(now) >= dueOn(b),
      depositCents: b.depositCents, refundableCents: refundableOf(b),
      method: card ? 'Card' : 'EFT',
      paygateRef: txIdOf(toCard) || (card && card.raw && card.raw.TRANSACTION_ID ? String(card.raw.TRANSACTION_ID) : null),
      // Can this refund go back to the card through Paygate?
      canSendToCard: !!toCard && paygate.refundsReady(),
      cardPaidCents: toCard ? toCard.amountCents : null,
      // Paid by card, but too long ago for Paygate to refund: it has to go by EFT.
      cardTooOld: !toCard && cardPayments(pays).length > 0,
      refund: b.depositRefund || null,
      // The guest's page (what they see, with the evidence), once a refund exists.
      guestLink: b.depositRefund ? depositLink(b.id) : null,
    };
  });
}

async function startRefund(bookingId, { amountCents, note, photoIds, files }, by, now = new Date()) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: { depositRefund: true } });
  if (!b || !b.depositCents) return { error: 'not_found', status: 404, message: 'This booking has no deposit.' };
  if (b.status !== 'confirmed' || b.depositStatus !== 'held') return { error: 'not_held', status: 409, message: 'This deposit is no longer held.' };
  if (b.depositRefund) return { error: 'already_started', status: 409, message: 'A refund has already been started for this deposit.' };
  if (today(now) < dueOn(b)) return { error: 'not_due', status: 409, message: `This deposit can't be refunded before ${dueOn(b)}, ${WAIT_DAYS} days after checkout.` };
  const max = refundableOf(b);
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > max) return { error: 'bad_amount', status: 400, message: `The refund must be between R0.01 and ${rand(max)}.` };
  const reason = String(note || '').trim();
  if (amountCents < max && !reason) return { error: 'note_required', status: 400, message: 'Say why the refund is less than the deposit.' };
  const ev = await checkEvidence(b, { photoIds, files });
  if (ev.error) return ev;
  let refund;
  try {
    refund = await prisma.depositRefund.create({ data: { bookingId, amountCents, note: reason || null, startedBy: by } });
  } catch (e) {
    if (e.code === 'P2002') return { error: 'already_started', status: 409, message: 'A refund has already been started for this deposit.' };
    throw e;
  }
  await saveEvidence(refund.id, ev);
  // Less than the deposit: the guest agrees it before anything is paid.
  if (amountCents < max) {
    const asked = await askGuest(refund.id, now);
    return { refund: asked.refund || refund, askedGuest: !asked.error, message: asked.message };
  }
  return { refund };
}

// ---- Evidence: report photos and invoices the guest sees on their link ----
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_FILES = 6;
const MAX_PHOTOS = 30;
const EVIDENCE_DAYS_BEFORE = 1, EVIDENCE_DAYS_AFTER = 7;

// Reports on this booking's unit from the day before checkout to a week after,
// with their photos, to pick evidence from.
async function evidenceOptions(bookingId) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!b) return { error: 'not_found', status: 404, message: 'Booking not found.' };
  if (!b.unitId) return { reports: [] };
  const out = new Date(shownCheckOut(b)).getTime();
  const reports = await prisma.formSubmission.findMany({
    where: { unitId: b.unitId, status: { not: 'incomplete' }, createdAt: { gte: new Date(out - EVIDENCE_DAYS_BEFORE * DAY_MS), lte: new Date(out + EVIDENCE_DAYS_AFTER * DAY_MS) } },
    select: { id: true, type: true, submitterName: true, createdAt: true, photos: { select: { id: true, fieldId: true }, orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  return { checkOut: iso(shownCheckOut(b)), reports: reports.filter((r) => r.photos.length) };
}

// Check photo ids (they must come from reports on this booking's unit) and decode
// uploaded files. Returns { photoIds, files } ready to save, or an error.
async function checkEvidence(b, { photoIds, files } = {}, already = { photos: 0, files: 0 }) {
  const ids = [...new Set((Array.isArray(photoIds) ? photoIds : []).map(String))];
  if (ids.length + already.photos > MAX_PHOTOS) return { error: 'too_many_photos', status: 400, message: `Attach at most ${MAX_PHOTOS} photos.` };
  if (ids.length) {
    const found = await prisma.photo.findMany({ where: { id: { in: ids } }, select: { id: true, formSubmission: { select: { unitId: true } } } });
    if (found.length !== ids.length || found.some((p) => !p.formSubmission || p.formSubmission.unitId !== b.unitId)) {
      return { error: 'bad_photo', status: 400, message: 'Those photos aren’t from this unit’s reports.' };
    }
  }
  const list = Array.isArray(files) ? files : [];
  if (list.length + already.files > MAX_FILES) return { error: 'too_many_files', status: 400, message: `Attach at most ${MAX_FILES} invoices.` };
  const decoded = [];
  for (const f of list) {
    let { filename, contentType, dataBase64 } = f || {};
    const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataBase64 || ''));
    if (m) { contentType = contentType || m[1]; dataBase64 = m[2]; }
    contentType = String(contentType || '').toLowerCase();
    if (!FILE_TYPES.includes(contentType)) return { error: 'bad_file', status: 400, message: `${filename || 'That file'} isn’t a PDF or photo.` };
    const data = Buffer.from(String(dataBase64 || ''), 'base64');
    if (!data.length) return { error: 'bad_file', status: 400, message: `${filename || 'That file'} is empty.` };
    if (data.length > MAX_FILE_BYTES) return { error: 'file_too_big', status: 400, message: `${filename || 'That file'} is over 6 MB.` };
    decoded.push({ filename: String(filename || 'invoice').slice(0, 120), contentType, sizeBytes: data.length, data });
  }
  return { photoIds: ids, files: decoded };
}

async function saveEvidence(refundId, ev, current = []) {
  if (ev.photoIds.length) await prisma.depositRefund.update({ where: { id: refundId }, data: { photoIds: [...new Set([...current, ...ev.photoIds])] } });
  for (const f of ev.files) await prisma.refundFile.create({ data: { refundId, ...f } });
}

// Add evidence to a refund that hasn't been agreed yet (send it to the guest again after).
async function addEvidence(id, { photoIds, files } = {}) {
  const r = await prisma.depositRefund.findUnique({ where: { id }, include: { booking: true, files: { select: { id: true } } } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (!['started', 'guest', 'disputed'].includes(r.status)) return { error: 'too_late', status: 409, message: 'Evidence can only be added before the refund is approved.' };
  const ev = await checkEvidence(r.booking, { photoIds, files }, { photos: (r.photoIds || []).length, files: r.files.length });
  if (ev.error) return ev;
  await saveEvidence(id, ev, r.photoIds || []);
  return { ok: true, message: 'Attached. Use “Send again” so the guest is told there’s more on their link.' };
}

// Remove one piece of evidence before the refund is agreed.
async function removeEvidence(id, { photoId, fileId } = {}) {
  const r = await prisma.depositRefund.findUnique({ where: { id } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (!['started', 'guest', 'disputed'].includes(r.status)) return { error: 'too_late', status: 409, message: 'Evidence can only be changed before the refund is approved.' };
  if (photoId) await prisma.depositRefund.update({ where: { id }, data: { photoIds: (r.photoIds || []).filter((p) => p !== photoId) } });
  if (fileId) await prisma.refundFile.deleteMany({ where: { id: fileId, refundId: id } });
  return { ok: true };
}

// An invoice, for the guest's link (only one attached to their own refund) or the admin.
async function evidenceFile(fileId, bookingId = null) {
  const f = await prisma.refundFile.findUnique({ where: { id: fileId }, include: { refund: { select: { bookingId: true } } } });
  if (!f || (bookingId && f.refund.bookingId !== bookingId)) return null;
  return f;
}

const evidenceCount = (r, nFiles) => (r.photoIds || []).length + nFiles;

const placeOf = (b) => [b.unit?.property?.name, b.unit?.name && `Unit ${b.unit.name}`].filter(Boolean).join(', ') || 'your stay';
const firstName = (b) => String(b.guestName || '').trim().split(/\s+/)[0] || 'there';
const WITH_PLACE = { unit: { include: { property: { select: { name: true } } } } };

// Send (or send again) the guest the reduced refund and the link to agree or not.
async function askGuest(id, now = new Date()) {
  const r = await prisma.depositRefund.findUnique({ where: { id }, include: { booking: { include: WITH_PLACE }, files: { select: { id: true } } } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (!['started', 'guest'].includes(r.status)) return { error: 'not_waiting', status: 409, message: 'This refund is not waiting for the guest.' };
  const b = r.booking;
  const max = refundableOf(b);
  if (r.amountCents >= max) return { error: 'full_refund', status: 409, message: 'This is a full refund, so the guest doesn’t need to agree it.' };
  const kept = max - r.amountCents;
  const text = `Hi ${firstName(b)}, about the ${rand(max)} breakage deposit for your stay at ${placeOf(b)}.\n\n`
    + `${rand(kept)} is being kept back: ${r.note || 'see the reason on the link below'}.\n`
    + `That leaves ${rand(r.amountCents)} to refund to you.\n\n`
    + (evidenceCount(r, r.files.length) ? `The photos and invoices are on this link. ` : '')
    + `Please let us know whether you agree: ${depositLink(b.id)}\n\n`
    + `As soon as you agree, your refund of ${rand(r.amountCents)} is sent. If you don’t agree, the deposit stays held until it’s sorted out.`;
  const sent = await messaging.sendHostMessage(b.id, text, { bookerOnly: true, notice: 'refund' })
    .catch((e) => { console.error('[depositRefund] ask guest failed', e.message); return null; });
  const wa = await whatsAppGuest(b, r);
  const updated = await prisma.depositRefund.update({ where: { id }, data: { status: 'guest', guestAskedAt: now } });
  const who = b.guestName || 'The guest';
  const ways = [b.guestEmail && `by email to ${b.guestEmail}`, wa.ok && `on WhatsApp to ${wa.to}`, 'in their SimonStays messages'].filter(Boolean);
  const noWa = wa.ok ? '' : wa.skipped === 'no_template' ? ' (WhatsApp isn’t set up for refunds yet)' : wa.skipped === 'no_guest_phone' ? ' (no phone number for WhatsApp)' : ' (the WhatsApp didn’t send)';
  return {
    ok: true, refund: updated,
    message: sent && sent.ok
      ? `${who} has been asked to agree the refund of ${rand(r.amountCents)}: ${ways.join(', ')}${noWa}. Their link: ${depositLink(b.id)}`
      : `The refund is waiting for ${who}, but the message could not be sent${wa.ok ? ' (the WhatsApp did go)' : ''}. Send them this link yourself: ${depositLink(b.id)}`,
  };
}

// WhatsApp the guest the reduced refund, with a button to their link. Needs the
// approved template TWILIO_WHATSAPP_REFUND_CONTENT_SID ("simonstays_deposit_refund"):
//   {{1}} first name · {{2}} where they stayed · {{3}} what's kept back and the refund, one line
//   button "Review my refund" → https://simonstays.co.za/deposit/{{4}} ({{4}} = the link's key).
const oneLine = (s, max) => String(s || '').replace(/\s*\n+\s*/g, ' · ').replace(/[\t ]{2,}/g, ' ').trim().slice(0, max) || '—';
function refundWhatsApp(b, r) {
  const max = refundableOf(b);
  const link = depositLink(b.id);
  const proof = r.files && evidenceCount(r, r.files.length) ? ' · Photos and invoices are on the link' : '';
  const summary = oneLine(`${rand(max - r.amountCents)} kept back for: ${r.note || 'see the link'} · Refund to you: ${rand(r.amountCents)}${proof}`, 600);
  const body = `Hi ${firstName(b)}, there's an update on the breakage deposit for your SimonStays stay at ${placeOf(b)}.\n\n${summary}\n\nPlease tap the button below to agree, or tell us if you don't. As soon as you agree, your refund is sent.\n${link}`;
  return { body, contentVariables: { 1: firstName(b), 2: oneLine(placeOf(b), 200), 3: summary, 4: link.split('/deposit/')[1] } };
}
async function whatsAppGuest(b, r) {
  try {
    const wa = require('./whatsapp');
    const template = String(process.env.TWILIO_WHATSAPP_REFUND_CONTENT_SID || '').trim();
    if (!wa.enabled() || !template) return { ok: false, skipped: 'no_template' };
    let phone = b.guestPhone || null;
    if (!phone && b.guestAccountId) {
      const a = await prisma.guestAccount.findUnique({ where: { id: b.guestAccountId }, select: { phone: true } });
      phone = a && a.phone;
    }
    if (!phone) return { ok: false, skipped: 'no_guest_phone' };
    const { body, contentVariables } = refundWhatsApp(b, r);
    const out = await wa.sendWhatsApp({ to: phone, body, contentSid: template, contentVariables });
    if (!out.ok) console.warn('[depositRefund] WhatsApp not sent', b.id, out.error || out.skipped);
    return out;
  } catch (e) { console.error('[depositRefund] WhatsApp failed', e.message); return { ok: false, error: e.message }; }
}

function alertAdmin(subject, lines) {
  const site = (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
  return sendMail({ to: ADMIN_EMAIL, subject, text: `${lines.join('\n')}\n\nRefunds tab: ${site}/hosting/admin` })
    .catch((e) => console.error('[depositRefund] admin alert failed', e.message));
}

// What the guest sees on their link.
async function guestView(bookingId) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: { depositRefund: { include: { files: { select: { id: true, filename: true, contentType: true }, orderBy: { createdAt: 'asc' } } } }, ...WITH_PLACE } });
  if (!b || !b.depositRefund) return null;
  const r = b.depositRefund;
  const max = refundableOf(b);
  return {
    place: placeOf(b), checkOut: iso(shownCheckOut(b)), guestName: b.guestName || null,
    depositCents: max, refundCents: r.amountCents, keptCents: Math.max(0, max - r.amountCents), reason: r.note || null,
    photos: (r.photoIds || []).map((id) => ({ id })),
    files: r.files.map((f) => ({ id: f.id, filename: f.filename, contentType: f.contentType })),
    // waiting | agreed | disputed | paid | other
    state: r.status === 'guest' ? 'waiting' : r.status === 'disputed' ? 'disputed' : r.status === 'paid' ? 'paid' : r.guestReply === 'agreed' ? 'agreed' : 'other',
  };
}

// The guest's answer. Agreeing approves the refund and pays it when it can go
// straight back to their card; otherwise SimonStays pays it by hand.
async function guestAnswer(bookingId, { answer, comment } = {}, now = new Date(), deps = {}) {
  const r = await prisma.depositRefund.findUnique({ where: { bookingId }, include: { booking: { include: WITH_PLACE } } });
  if (!r) return { error: 'not_found', status: 404, message: 'There is no refund waiting for you.' };
  if (r.status !== 'guest') return { error: 'answered', status: 409, message: 'This has already been answered. If something has changed, reply to our email.' };
  const b = r.booking;
  const who = `${b.guestName || 'Guest'} (${placeOf(b)}${b.ref ? `, ${b.ref}` : ''})`;
  const kept = refundableOf(b) - r.amountCents;
  if (answer === 'disagree') {
    const why = String(comment || '').trim().slice(0, 1000);
    if (!why) return { error: 'reason_required', status: 400, message: 'Please tell us why you don’t agree.' };
    const ok = await prisma.depositRefund.updateMany({ where: { id: r.id, status: 'guest' }, data: { status: 'disputed', guestReply: why, guestAt: now } });
    if (!ok.count) return { error: 'answered', status: 409, message: 'This has already been answered.' };
    await alertAdmin(`Deposit refund not agreed: ${b.guestName || 'guest'}`, [
      `${who} does not agree to the deposit refund of ${rand(r.amountCents)} (${rand(kept)} kept back: ${r.note || 'no reason given'}).`, '',
      `Their reason: ${why}`, '', 'The deposit stays held.']);
    return { ok: true, state: 'disputed' };
  }
  if (answer !== 'agree') return { error: 'bad_answer', status: 400, message: 'Say whether you agree.' };
  const ok = await prisma.depositRefund.updateMany({ where: { id: r.id, status: 'guest' }, data: { status: 'approved', guestReply: 'agreed', guestAt: now, approvedBy: `guest: ${b.guestName || b.guestEmail || 'agreed on link'}`, approvedAt: now } });
  if (!ok.count) return { error: 'answered', status: 409, message: 'This has already been answered.' };

  // Pay it now if it can go back to the card through Paygate.
  const pays = await paymentsOf(b);
  if (cardPaymentOf(pays, now) && paygate.refundsReady()) {
    const out = await sendToPaygate(r.id, 'auto (guest agreed)', now, deps).catch((e) => ({ message: e.message }));
    if (out.ok && out.outcome === 'sent') {
      await alertAdmin(`Deposit refund agreed and sent: ${b.guestName || 'guest'}`, [`${who} agreed the refund of ${rand(r.amountCents)}, and it has been sent back to their card through Paygate.`]);
      return { ok: true, state: 'paid', via: 'card' };
    }
    await alertAdmin(`Deposit refund agreed, needs you: ${b.guestName || 'guest'}`, [
      `${who} agreed the refund of ${rand(r.amountCents)}, but sending it to their card didn’t finish: ${out.message || 'no reply'}.`, '',
      'Check the Refunds tab before doing anything else.']);
    return { ok: true, state: 'agreed', via: 'card' };
  }
  await alertAdmin(`Deposit refund agreed, pay by EFT: ${b.guestName || 'guest'}`, [
    `${who} agreed the refund of ${rand(r.amountCents)}.`, '',
    'It can’t go back to a card automatically, so pay it by EFT and mark it paid in the Refunds tab.']);
  return { ok: true, state: 'agreed', via: 'eft' };
}

// The sign-off: the amount is typed again and must match what was started.
async function approveRefund(id, { amountCents }, by, now = new Date()) {
  const r = await prisma.depositRefund.findUnique({ where: { id } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (amountCents !== r.amountCents) return { error: 'amount_mismatch', status: 400, message: `That doesn't match the refund of ${rand(r.amountCents)}. Type ${rand(r.amountCents)} to approve it, or cancel it and start again with a different amount.` };
  // A reduced refund waiting on (or disputed by) the guest can still be approved
  // here, when the guest agreed some other way (phone, WhatsApp).
  const claimed = await prisma.depositRefund.updateMany({ where: { id, status: { in: ['started', 'guest', 'disputed'] } }, data: { status: 'approved', approvedBy: by, approvedAt: now } });
  if (!claimed.count) return { error: 'not_started', status: 409, message: 'This refund is not waiting for approval.' };
  return { ok: true };
}

// Move a refund from `from` to paid, mark the deposit refunded and tell the guest.
async function finishPaid(r, from, data, now) {
  const done = await prisma.$transaction(async (tx) => {
    const claimed = await tx.depositRefund.updateMany({ where: { id: r.id, status: from }, data: { ...data, status: 'paid', paidAt: now } });
    if (!claimed.count) return false;
    await tx.booking.update({ where: { id: r.bookingId }, data: { depositStatus: 'refunded' } });
    return true;
  });
  if (!done) return false;
  const text = data.via === 'paygate'
    ? `Your deposit refund of ${rand(r.amountCents)} has been sent back to the card you paid with. It can take 7 to 14 days to show on your statement, or 14 to 21 days for a card issued outside South Africa.`
    : `Your deposit refund of ${rand(r.amountCents)} has been paid.`;
  await messaging.sendHostMessage(r.bookingId, text, { bookerOnly: true, notice: 'refund' })
    .catch((e) => console.error('[depositRefund] guest message failed', e.message));
  return true;
}

// Paid by hand (EFT, or in the Paygate portal), recorded with its reference.
async function markRefundPaid(id, { reference }, by, now = new Date()) {
  const ref = String(reference || '').trim();
  if (!ref) return { error: 'reference_required', status: 400, message: 'Enter the bank or Paygate reference for this payment.' };
  const r = await prisma.depositRefund.findUnique({ where: { id } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (!await finishPaid(r, 'approved', { reference: ref, paidBy: by, via: null }, now)) return { error: 'not_approved', status: 409, message: 'Only an approved refund can be marked as paid.' };
  return { ok: true };
}

// Send an approved refund back to the guest's card through Paygate.
async function sendToPaygate(id, by, now = new Date(), { refund = paygate.refund } = {}) {
  const r = await prisma.depositRefund.findUnique({ where: { id }, include: { booking: true } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (r.status !== 'approved') return { error: 'not_approved', status: 409, message: 'Only an approved refund can be sent to Paygate.' };
  if (!paygate.refundsReady()) return { error: 'not_set_up', status: 409, message: 'Paygate refunds are not set up yet (PayHost password missing). Pay this one by hand.' };
  const pays = await paymentsOf(r.booking);
  const pay = cardPaymentOf(pays, now);
  if (!pay) {
    if (cardPayments(pays).length) return { error: 'card_too_old', status: 409, message: `The card payment is more than ${CARD_REFUND_MONTHS} months old, so Paygate can't refund it. Pay this one by EFT.` };
    return { error: 'no_card_payment', status: 409, message: 'No Paygate card payment was found for this booking. Pay this one by hand.' };
  }
  // One card payment can cover several deposits (an invoice with several units).
  const others = await prisma.depositRefund.aggregate({ _sum: { amountCents: true }, where: { paymentId: pay.id, via: 'paygate', status: { in: ['check', 'paid'] }, id: { not: id } } });
  const left = pay.amountCents - (others._sum.amountCents || 0);
  if (r.amountCents > left) return { error: 'too_much', status: 409, message: `Only ${rand(Math.max(0, left))} of that card payment is left to refund.` };

  // Claim it first: from here on it is never sent again without a person checking.
  const claimed = await prisma.depositRefund.updateMany({ where: { id, status: 'approved' }, data: { status: 'check', via: 'paygate', paymentId: pay.id, sentBy: by, sentAt: now, lastError: null } });
  if (!claimed.count) return { error: 'not_approved', status: 409, message: 'This refund is already being sent.' };

  const out = await refund({ transactionId: txIdOf(pay), amountCents: r.amountCents });
  const reply = out.reply || null;
  if (out.outcome === 'sent') {
    await finishPaid(r, 'check', { reference: (reply && reply.transactionId) || 'Paygate', paidBy: by, via: 'paygate', paygate: reply }, now);
    return { ok: true, outcome: 'sent', message: `Paygate has the refund of ${rand(r.amountCents)} and passes it to the bank.` };
  }
  if (out.outcome === 'rejected') {
    await prisma.depositRefund.updateMany({ where: { id, status: 'check' }, data: { status: 'approved', via: null, paymentId: null, sentBy: null, sentAt: null, lastError: out.message, paygate: reply } });
    return { error: 'paygate_rejected', status: 502, message: `Paygate refused the refund, so no money moved: ${out.message}` };
  }
  await prisma.depositRefund.update({ where: { id }, data: { paygate: reply, lastError: out.message } });
  return { ok: true, outcome: 'unclear', message: `Paygate's reply was unclear (${out.message}). Check in the Paygate portal whether it went through before doing anything else.` };
}

// After checking with Paygate: it went through (with Paygate's reference), or it didn't.
async function resolveCheck(id, { outcome, reference }, by, now = new Date()) {
  const r = await prisma.depositRefund.findUnique({ where: { id } });
  if (!r) return { error: 'not_found', status: 404, message: 'Refund not found.' };
  if (r.status !== 'check') return { error: 'not_check', status: 409, message: 'This refund is not waiting to be checked.' };
  if (outcome === 'went_through') {
    const ref = String(reference || '').trim();
    if (!ref) return { error: 'reference_required', status: 400, message: 'Enter the Paygate reference for the refund.' };
    if (!await finishPaid(r, 'check', { reference: ref, paidBy: by, via: 'paygate' }, now)) return { error: 'not_check', status: 409, message: 'This refund is not waiting to be checked.' };
    return { ok: true };
  }
  if (outcome === 'not_sent') {
    const back = await prisma.depositRefund.updateMany({ where: { id, status: 'check' }, data: { status: 'approved', via: null, paymentId: null, sentBy: null, sentAt: null, lastError: `Checked by ${by}: Paygate did not receive it.` } });
    if (!back.count) return { error: 'not_check', status: 409, message: 'This refund is not waiting to be checked.' };
    return { ok: true };
  }
  return { error: 'bad_outcome', status: 400, message: 'Say whether the refund went through.' };
}

// Called off before any money moves; the deposit simply stays held.
async function cancelRefund(id) {
  const gone = await prisma.depositRefund.deleteMany({ where: { id, status: { in: ['started', 'guest', 'disputed', 'approved'] } } });
  if (!gone.count) return { error: 'not_cancellable', status: 409, message: 'A paid refund cannot be cancelled.' };
  return { ok: true };
}

module.exports = { evidenceOptions, addEvidence, removeEvidence, evidenceFile, refundWhatsApp, WAIT_DAYS, listRefunds, startRefund, askGuest, guestView, guestAnswer, approveRefund, markRefundPaid, sendToPaygate, resolveCheck, cancelRefund, cardPaymentOf };
