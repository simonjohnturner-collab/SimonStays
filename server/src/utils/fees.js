// The SimonStays service fee: the share SimonStays keeps from every booking made
// through SimonStays (the website/app — not Airbnb or the host's direct
// bookings). It funds hosting, the AI, payment processing and so on.
// SIMONSTAYS_FEE_PERCENT overrides the default 10%.
const FEE_PERCENT = Number(process.env.SIMONSTAYS_FEE_PERCENT) || 10;

const feeOf = (grossCents) => Math.round((grossCents || 0) * FEE_PERCENT / 100);

// A booking's fee base: the stay's value (accommodation + cleaning + extras),
// excluding the refundable breakage deposit and the 50/50 plan's admin fee,
// which goes to SimonStays in full. A guest's welcome discount is added back:
// SimonStays bears it, so the host is paid as if the guest paid full price.
function grossOf(b) {
  const total = b.totalCents != null ? b.totalCents : (b.quotedCents || 0);
  return Math.max(0, total - (b.depositCents || 0) - (b.splitFeeCents || 0) + (b.welcomeDiscountCents || 0));
}

// All SimonStays keeps from a booking: its service fee, less any welcome
// discount it gave the guest, plus any 50/50 plan admin fee.
const simonStaysCutOf = (b) => feeOf(grossOf(b)) - (b.welcomeDiscountCents || 0) + (b.splitFeeCents || 0);

module.exports = { FEE_PERCENT, feeOf, grossOf, simonStaysCutOf };
