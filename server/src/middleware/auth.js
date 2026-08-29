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

module.exports = { authHost, requireOwnedUnit, requireOwnedProperty };
