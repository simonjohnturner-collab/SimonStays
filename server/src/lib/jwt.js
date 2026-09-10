const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret';
const EXPIRES = '30d';

function sign(host) {
  return jwt.sign({ hostId: host.id, email: host.email }, SECRET, { expiresIn: EXPIRES });
}

function verify(token) {
  return jwt.verify(token, SECRET); // throws on invalid/expired
}

// A short-lived signed token for carrying state through OAuth redirects.
function signShort(payload, expiresIn = '15m') {
  return jwt.sign(payload, SECRET, { expiresIn });
}

module.exports = { sign, verify, signShort };
