// The SimonStays service fee: the share SimonStays keeps from every booking made
// through SimonStays (the website/app — not Airbnb or the host's direct
// bookings). It funds hosting, the AI, payment processing and so on.
// SIMONSTAYS_FEE_PERCENT overrides the default 10%.
const FEE_PERCENT = Number(process.env.SIMONSTAYS_FEE_PERCENT) || 10;

const feeOf = (grossCents) => Math.round((grossCents || 0) * FEE_PERCENT / 100);

// A booking's fee base: what the guest pays for the stay (accommodation +
// cleaning + extras), excluding the refundable breakage deposit.
function grossOf(b) {
  const total = b.totalCents != null ? b.totalCents : (b.quotedCents || 0);
  return Math.max(0, total - (b.depositCents || 0));
}

module.exports = { FEE_PERCENT, feeOf, grossOf };
