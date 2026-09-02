// Payment abstraction for the public shopfront booking site.
//
// A payments vendor is being onboarded. Until its details are in, we run in
// 'simulate' mode: no real charge, so the whole booking flow can be tested end
// to end. A booking is only CONFIRMED (and the calendar blocked) after a
// successful payment here — never before.
//
// When the vendor is live:
//   1. Implement createCheckout(): create a checkout/session with the vendor and
//      return { mode: 'redirect', url, reference } so the guest is sent to pay.
//   2. Implement verifyPayment(): confirm the charge with the vendor (ideally
//      driven by a validated webhook) before returning { ok: true }.
//   3. Set PAYMENT_MODE=live in the API environment.

const MODE = process.env.PAYMENT_MODE || 'simulate';

async function createCheckout(booking, amountCents) {
  if (MODE !== 'live') return { mode: 'simulate', amountCents };
  // TODO(vendor): create a checkout session and return { mode:'redirect', url, reference }.
  return { mode: 'simulate', amountCents };
}

async function verifyPayment(booking, body) {
  if (MODE !== 'live') return { ok: true, simulated: true };
  // TODO(vendor): verify the payment (or trust a validated webhook) before ok:true.
  return { ok: false, message: 'Online payment is not yet configured.' };
}

module.exports = { createCheckout, verifyPayment, MODE };
