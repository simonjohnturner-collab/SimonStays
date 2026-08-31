const express = require('express');
const prisma = require('../lib/prisma');
const { authHost, requireOwnedProperty, requireOwnedUnit } = require('../middleware/auth');

const router = express.Router();

// GET /photos/:id — public image bytes. Used by <img src> in the admin Listings
// tab and, later, the public booking site. Ids are unguessable uuids.
router.get('/:id', async (req, res) => {
  const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });
  if (!photo) return res.status(404).json({ error: 'not_found' });
  res.set('Content-Type', photo.contentType || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(photo.data));
});

// Decode a data URL (or bare base64) into { buffer, contentType }.
function decodeImage(body) {
  let { dataBase64, contentType } = body || {};
  if (!dataBase64) return null;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataBase64);
  if (m) { contentType = contentType || m[1]; dataBase64 = m[2]; }
  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length) return null;
  return { buffer, contentType: contentType || 'image/jpeg' };
}

// Append to the end of the set (max sort + 1) so new photos land last.
async function nextSort(where) {
  const agg = await prisma.photo.aggregate({ where, _max: { sort: true } });
  return (agg._max.sort ?? -1) + 1;
}

const outSelect = { id: true, sort: true, filename: true, contentType: true };

// POST /photos/property/:propertyId  { dataBase64, contentType, filename }
router.post('/property/:propertyId', authHost, requireOwnedProperty, async (req, res) => {
  const img = decodeImage(req.body);
  if (!img) return res.status(400).json({ error: 'no_image' });
  const sort = await nextSort({ propertyId: req.property.id });
  const photo = await prisma.photo.create({
    data: { propertyId: req.property.id, data: img.buffer, contentType: img.contentType, filename: req.body.filename || null, sort },
    select: outSelect,
  });
  res.status(201).json({ photo });
});

// POST /photos/unit/:unitId  { dataBase64, contentType, filename }
router.post('/unit/:unitId', authHost, requireOwnedUnit, async (req, res) => {
  const img = decodeImage(req.body);
  if (!img) return res.status(400).json({ error: 'no_image' });
  const sort = await nextSort({ unitId: req.unit.id });
  const photo = await prisma.photo.create({
    data: { unitId: req.unit.id, data: img.buffer, contentType: img.contentType, filename: req.body.filename || null, sort },
    select: outSelect,
  });
  res.status(201).json({ photo });
});

// Load a photo and assert the authenticated host owns its property/unit.
async function requireOwnedPhoto(req, res, next) {
  const photo = await prisma.photo.findUnique({
    where: { id: req.params.id },
    include: { property: true, unit: { include: { property: true } } },
  });
  if (!photo) return res.status(404).json({ error: 'not_found' });
  const ownerHost = photo.property ? photo.property.hostId : photo.unit ? photo.unit.property.hostId : null;
  if (ownerHost !== req.hostId) return res.status(403).json({ error: 'forbidden' });
  req.photo = photo;
  next();
}

// PATCH /photos/:id { sort } — set the cover / reorder.
router.patch('/:id', authHost, requireOwnedPhoto, async (req, res) => {
  const data = {};
  if (req.body && req.body.sort != null) data.sort = Number(req.body.sort);
  const photo = await prisma.photo.update({ where: { id: req.photo.id }, data, select: outSelect });
  res.json({ photo });
});

// DELETE /photos/:id
router.delete('/:id', authHost, requireOwnedPhoto, async (req, res) => {
  await prisma.photo.delete({ where: { id: req.photo.id } });
  res.json({ ok: true });
});

module.exports = router;
