const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret';
const EXPIRES = '30d';

function sign(host) {
  return jwt.sign({ hostId: host.id, email: host.email }, SECRET, { expiresIn: EXPIRES });
}

function verify(token) {
  return jwt.verify(token, SECRET); // throws on invalid/expired
}

module.exports = { sign, verify };
