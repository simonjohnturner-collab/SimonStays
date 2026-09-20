const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret';
const EXPIRES = '30d';

function sign(host) {
  return jwt.sign({ hostId: host.id, email: host.email }, SECRET, { expiresIn: EXPIRES });
}

// A guest (shopfront customer) token. `kind:'guest'` keeps it distinct from a
// host token so the two auth middlewares never accept each other's tokens.
function signGuest(acct) {
  return jwt.sign({ guestId: acct.id, email: acct.email, kind: 'guest' }, SECRET, { expiresIn: EXPIRES });
}

function verify(token) {
  return jwt.verify(token, SECRET); // throws on invalid/expired
}

// A short-lived signed token for carrying state through OAuth redirects.
function signShort(payload, expiresIn = '15m') {
  return jwt.sign(payload, SECRET, { expiresIn });
}

module.exports = { sign, signGuest, verify, signShort };
