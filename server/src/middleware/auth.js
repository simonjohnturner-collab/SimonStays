const { verify } = require('../lib/jwt');
const prisma = require('../lib/prisma');

/** Require a valid host JWT. Sets req.hostId. */
function authHost(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    const payload = verify(token);
    req.hostId = payload.hostId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

/**
 * Load a unit by id and assert it belongs to the authenticated host.
 * Attaches req.unit. Use after authHost on routes with :unitId.
 */
async function requireOwnedUnit(req, res, next) {
  const unitId = req.params.unitId || req.params.id;
  const unit = await prisma.unit.findUnique({
    where: { id: unitId },
    include: { property: true, channels: true },
  });
  if (!unit) return res.status(404).json({ error: 'unit_not_found' });
  if (unit.property.hostId !== req.hostId) return res.status(403).json({ error: 'forbidden' });
  req.unit = unit;
  next();
}

/** Same for a property. Attaches req.property. */
async function requireOwnedProperty(req, res, next) {
  const propertyId = req.params.propertyId || req.params.id;
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property) return res.status(404).json({ error: 'property_not_found' });
  if (property.hostId !== req.hostId) return res.status(403).json({ error: 'forbidden' });
  req.property = property;
  next();
}

// The SimonStays super-admin: the one account allowed to list all hosts and
// sign in as them. Configurable via ADMIN_EMAIL; defaults to Simon's account.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'simonjohnturner@outlook.com').toLowerCase();
function isAdminEmail(email) { return !!email && String(email).toLowerCase() === ADMIN_EMAIL; }

/** Require the authenticated host to be the super-admin. Use after authHost. */
async function requireAdmin(req, res, next) {
  const host = await prisma.host.findUnique({ where: { id: req.hostId } });
  if (!host || !isAdminEmail(host.email)) return res.status(403).json({ error: 'forbidden' });
  req.adminHost = host;
  next();
}

module.exports = { authHost, requireOwnedUnit, requireOwnedProperty, requireAdmin, isAdminEmail, ADMIN_EMAIL };
