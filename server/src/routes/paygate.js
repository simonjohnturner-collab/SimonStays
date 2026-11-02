// Paygate PayWeb3 callbacks. Neither is trusted on its own: both end in asking
// Paygate directly (payments.reconcile → query.trans) how the payment went.
const express = require('express');
const prisma = require('../lib/prisma');
const payments = require('../utils/payments');

const router = express.Router();

// POST /public/paygate/notify — server-to-server result. The body is read RAW so
// its checksum (all fields, in the order sent) can be verified. Paygate needs a
// plain-text "OK" or it retries.
router.post('/notify', express.text({ type: 'application/x-www-form-urlencoded', limit: '64kb' }), async (req, res) => {
  const raw = typeof req.body === 'string' ? req.body : '';
  res.type('text/plain').send('OK');
  try {
    const r = await payments.handleNotify(raw);
    if (r.ok) console.log('[paygate] notify', r.outcome);
    else console.warn('[paygate] notify rejected:', r.reason);
  } catch (e) { console.error('[paygate] notify failed', e); }
});

// GET /public/paygate/go/:paymentId — a page that posts the guest straight on
// to Paygate's payment page. The app opens this in an in-app browser (which can
// only open a link, not post a form). The payment id is the capability.
router.get('/go/:paymentId', async (req, res) => {
  const paygate = require('../utils/paygate');
  const p = await prisma.payment.findUnique({ where: { id: req.params.paymentId } }).catch(() => null);
  if (!p || p.status !== 'pending' || !p.providerRef) return res.status(404).type('html').send('<p style="font-family:sans-serif">This payment link has expired. Please go back to the app and try again.</p>');
  const c = paygate.config();
  const checksum = paygate.md5(`${c.paygateId}${p.providerRef}${p.id}${c.key}`);
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SimonStays · Secure payment</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px;color:#1f2a24">
<p>Taking you to Paygate’s secure payment page…</p>
<form id="f" method="POST" action="${paygate.PROCESS_URL}">
<input type="hidden" name="PAY_REQUEST_ID" value="${esc(p.providerRef)}"><input type="hidden" name="CHECKSUM" value="${esc(checksum)}">
<noscript><button type="submit">Continue to payment</button></noscript></form>
<script>document.getElementById('f').submit()</script></body></html>`);
});

// GET|POST /public/paygate/return/:paymentId — Paygate sends the guest's browser
// here after paying (usually as a POST). Check with Paygate, then send them to
// the shopfront's confirmation or "not completed" screen.
router.all('/return/:paymentId', async (req, res) => {
  const payment = await prisma.payment.findUnique({ where: { id: req.params.paymentId } }).catch(() => null);
  if (!payment) return res.redirect(303, '/');
  let fresh = payment;
  try {
    await payments.reconcile(payment);
    fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
  } catch (e) { console.error('[paygate] return reconcile failed', e.message); }
  const failed = ['DECLINED', 'CANCELLED', 'USER_CANCELLED', 'NOT_DONE', 'VOIDED'].includes(fresh.status);
  // An invoice from a conversation returns to its own page.
  if (payment.offerId) {
    const offer = await prisma.priceOffer.findUnique({ where: { id: payment.offerId } }).catch(() => null);
    if (offer) return res.redirect(303, `/invoice/${offer.token}?${failed ? 'payment=cancelled' : 'paid=1'}`);
  }
  const balance = payment.kind === 'balance' ? '&balance=1' : '';
  if (payment.returnTo) {
    // Back into the app (its in-app browser closes when it sees this link).
    const sep = payment.returnTo.includes('?') ? '&' : '?';
    return res.redirect(303, `${payment.returnTo}${sep}booking=${payment.bookingId}&result=${failed ? 'cancelled' : 'paid'}${balance}`);
  }
  res.redirect(303, `/?booking=${payment.bookingId}${failed ? '&payment=cancelled' : '&paid=1'}${balance}`);
});

module.exports = router;
