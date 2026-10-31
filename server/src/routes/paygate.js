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
  const balance = payment.kind === 'balance' ? '&balance=1' : '';
  res.redirect(303, `/?booking=${payment.bookingId}${failed ? '&payment=cancelled' : '&paid=1'}${balance}`);
});

module.exports = router;
