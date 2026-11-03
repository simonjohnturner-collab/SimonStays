// Shared documents. hostRouter is the host's own management; publicRouter is what
// a guest reaches through a property's folder link.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const { folderLink, validSignature, readUpload } = require('../utils/documents');

const listing = { id: true, name: true, sizeBytes: true, createdAt: true };

const hostRouter = express.Router();
hostRouter.use(authHost);

// GET /documents — this host's properties, each with its link and files.
hostRouter.get('/', async (req, res, next) => {
  try {
    const props = await prisma.property.findMany({
      where: { hostId: req.hostId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, documents: { select: listing, orderBy: { name: 'asc' } } },
    });
    res.json({ folders: props.map((p) => ({ propertyId: p.id, name: p.name, link: folderLink(p.id), documents: p.documents })) });
  } catch (e) { next(e); }
});

// POST /documents { propertyId, filename, dataBase64 }
hostRouter.post('/', async (req, res, next) => {
  try {
    const { propertyId, filename, dataBase64 } = req.body || {};
    const p = await prisma.property.findFirst({ where: { id: String(propertyId || ''), hostId: req.hostId }, select: { id: true } });
    if (!p) return res.status(404).json({ error: 'not_found' });
    const file = readUpload(filename, dataBase64);
    if (file.error) return res.status(400).json({ error: 'bad_file', message: file.error });
    const document = await prisma.document.create({
      data: { hostId: req.hostId, propertyId: p.id, name: file.name, contentType: file.contentType, sizeBytes: file.buffer.length, data: file.buffer },
      select: listing,
    });
    res.status(201).json({ document });
  } catch (e) { next(e); }
});

// DELETE /documents/:id
hostRouter.delete('/:id', async (req, res, next) => {
  try {
    const r = await prisma.document.deleteMany({ where: { id: req.params.id, hostId: req.hostId } });
    if (!r.count) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const publicRouter = express.Router();

// Every public route needs the folder's signed link.
publicRouter.use('/:propertyId/:sig', (req, res, next) => {
  if (!validSignature(req.params.propertyId, req.params.sig)) return res.status(404).json({ error: 'not_found' });
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// GET /public/documents/:propertyId/:sig — the folder's contents.
publicRouter.get('/:propertyId/:sig', async (req, res, next) => {
  try {
    const p = await prisma.property.findUnique({
      where: { id: req.params.propertyId },
      select: { name: true, host: { select: { name: true, biller: { select: { companyName: true, email: true } } } }, documents: { select: listing, orderBy: { name: 'asc' } } },
    });
    if (!p) return res.status(404).json({ error: 'not_found' });
    const biller = p.host.biller || {};
    res.json({ property: p.name, host: biller.companyName || p.host.name || null, returnEmail: biller.email || null, documents: p.documents });
  } catch (e) { next(e); }
});

// GET /public/documents/:propertyId/:sig/:documentId — always a download, never opened in place.
publicRouter.get('/:propertyId/:sig/:documentId', async (req, res, next) => {
  try {
    const d = await prisma.document.findFirst({ where: { id: req.params.documentId, propertyId: req.params.propertyId } });
    if (!d) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Content-Type', d.contentType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(d.data));
  } catch (e) { next(e); }
});

module.exports = { hostRouter, publicRouter };
