// A private link to a booking's conversation, for the guest who booked, that works
// without an account. The link itself is the key, so it's signed and stops working
// a while after the stay.
const crypto = require('crypto');

const LINK_DAYS_AFTER_STAY = 30;
const mac = (bookingId, purpose = 'guest-thread') => crypto.createHmac('sha256', `${purpose}:${process.env.JWT_SECRET || 'dev-secret'}`).update(bookingId).digest('base64url');

const threadToken = (bookingId) => `${bookingId}.${mac(bookingId)}`;
const siteBase = () => (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');

function threadLink(bookingId) {
  return `${siteBase()}/thread/${threadToken(bookingId)}`;
}

// The link a guest uses to rate their stay. A different key, so it can't open messages.
const rateLink = (bookingId) => `${siteBase()}/rate/${bookingId}.${mac(bookingId, 'guest-rate')}`;

// The booking id a token is for, or null if it isn't genuine.
function bookingIdOf(token, purpose = 'guest-thread') {
  const [id, given] = String(token || '').split('.');
  if (!id || !given) return null;
  const a = Buffer.from(given), b = Buffer.from(mac(id, purpose));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

const linkExpired = (booking, now = Date.now()) => new Date(booking.checkOut).getTime() + LINK_DAYS_AFTER_STAY * 864e5 < now;

module.exports = { threadLink, rateLink, bookingIdOf, linkExpired };
