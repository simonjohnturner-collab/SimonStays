// How a listing takes bookings, set per property by the host (Listings):
//   instant: any guest books and pays straight away, no approval.
//   rated:   instant for guests that previous hosts rated 5 stars; everyone else,
//            including new guests with no rating yet, sends a request.
//   request: every booking is a request the host approves (by sending the invoice).
// A request is an enquiry with dates: it holds nothing and charges nothing until
// the host approves and the guest pays the invoice.
const prisma = require('../lib/prisma');
const { guestRatingOf } = require('./ratings');

const MODES = ['instant', 'rated', 'request'];
const FIVE_STARS = 5; // the guest's average, to one decimal, as shown to hosts

const modeOf = (property) => (MODES.includes(property && property.bookingMode) ? property.bookingMode : 'instant');

// The guest's own rating from hosts. Only a signed-in account with a confirmed
// email counts: ratings are kept by email, and anyone can type someone else's.
async function ratingForAccount(guestId) {
  if (!guestId) return null;
  const acct = await prisma.guestAccount.findUnique({ where: { id: guestId }, select: { email: true, emailVerifiedAt: true } });
  if (!acct || !acct.emailVerifiedAt) return null;
  return guestRatingOf(acct.email.toLowerCase());
}

const isFiveStar = (rating) => !!rating && rating.count > 0 && rating.average >= FIVE_STARS;

// Can this guest book this property instantly? { ok, mode, reason }.
async function instantAllowed(property, guestId) {
  const mode = modeOf(property);
  if (mode === 'instant') return { ok: true, mode };
  if (mode === 'request') return { ok: false, mode, reason: 'This host approves every booking. Send a request and you’ll pay once they accept.' };
  const rating = await ratingForAccount(guestId);
  if (isFiveStar(rating)) return { ok: true, mode };
  return { ok: false, mode, reason: guestId
    ? 'Instant booking here is for guests rated 5 stars by their previous hosts. Send a request and you’ll pay once the host accepts.'
    : 'Sign in: guests rated 5 stars by their previous hosts can book this instantly. Otherwise send a request.' };
}

// Bookings that came in as a request to book (shown as "Booking request" to the host).
const REQUEST_PREFIX = 'Booking request';
const isRequest = (b) => !!b && b.status === 'enquiry' && String(b.comments || '').startsWith(REQUEST_PREFIX);

module.exports = { MODES, modeOf, instantAllowed, ratingForAccount, isFiveStar, REQUEST_PREFIX, isRequest };
