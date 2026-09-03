// Admin (auth) API for the Forms feature: design the form questions
// (FormTemplate) and review/search the completed submissions.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const { TYPES, defaultTemplate } = require('../utils/formDefaults');

const router = express.Router();
router.use(authHost);

// ---- Form design (templates) ----

// GET /forms/templates — the host's form definitions; a type with none yet comes
// back as an (unsaved) default so the builder always has something to edit.
router.get('/templates', async (req, res) => {
  const existing = await prisma.formTemplate.findMany({ where: { hostId: req.hostId } });
  const byType = Object.fromEntries(existing.map((t) => [t.type, t]));
  const templates = TYPES.map((type) =>
    byType[type] || { ...defaultTemplate(type), id: null, hostId: req.hostId, unsaved: true });
  res.json({ templates });
});

// PUT /forms/templates/:type — create/replace the (host, type) definition.
router.put('/templates/:type', async (req, res) => {
  const type = req.params.type;
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'invalid_type' });
  const b = req.body || {};
  const data = {
    title: b.title || defaultTemplate(type).title,
    description: b.description || null,
    fields: Array.isArray(b.fields) ? b.fields : [],
    active: b.active !== false,
  };
  const existing = await prisma.formTemplate.findFirst({ where: { hostId: req.hostId, type } });
  const template = existing
    ? await prisma.formTemplate.update({ where: { id: existing.id }, data })
    : await prisma.formTemplate.create({ data: { hostId: req.hostId, type, ...data } });
  res.json({ template });
});

// ---- Submissions (search + review) ----

// GET /forms/submissions?type=&propertyId=&status=&q=
router.get('/submissions', async (req, res) => {
  const { type, propertyId, status, q } = req.query;
  const where = { hostId: req.hostId };
  if (type) where.type = type;
  if (propertyId) where.propertyId = propertyId;
  if (status) where.status = status;
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { submitterName: { contains: term, mode: 'insensitive' } },
      { submitterContact: { contains: term, mode: 'insensitive' } },
    ];
  }
  const subs = await prisma.formSubmission.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      property: { select: { name: true } },
      unit: { select: { name: true } },
      _count: { select: { photos: true } },
    },
    take: 300,
  });
  res.json({ submissions: subs.map(fmtSub) });
});

// GET /forms/submissions/:id — full answers + photo ids
router.get('/submissions/:id', async (req, res) => {
  const sub = await prisma.formSubmission.findFirst({
    where: { id: req.params.id, hostId: req.hostId },
    include: {
      property: { select: { name: true } },
      unit: { select: { name: true } },
      photos: { select: { id: true, fieldId: true, filename: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!sub) return res.status(404).json({ error: 'not_found' });
  res.json({ submission: { ...fmtSub(sub), answers: sub.answers, photos: sub.photos } });
});

// PATCH /forms/submissions/:id { status }  (new | reviewed | resolved)
router.patch('/submissions/:id', async (req, res) => {
  const sub = await prisma.formSubmission.findFirst({ where: { id: req.params.id, hostId: req.hostId }, select: { id: true } });
  if (!sub) return res.status(404).json({ error: 'not_found' });
  const data = {};
  if ('status' in (req.body || {})) data.status = req.body.status;
  const updated = await prisma.formSubmission.update({ where: { id: sub.id }, data });
  res.json({ submission: { id: updated.id, status: updated.status } });
});

// DELETE /forms/submissions/:id
router.delete('/submissions/:id', async (req, res) => {
  const sub = await prisma.formSubmission.findFirst({ where: { id: req.params.id, hostId: req.hostId }, select: { id: true } });
  if (!sub) return res.status(404).json({ error: 'not_found' });
  await prisma.formSubmission.delete({ where: { id: sub.id } });
  res.json({ ok: true });
});

function fmtSub(s) {
  return {
    id: s.id, type: s.type, status: s.status,
    propertyId: s.propertyId, propertyName: s.property ? s.property.name : null,
    unitId: s.unitId, unitName: s.unit ? s.unit.name : null,
    submitterName: s.submitterName, submitterContact: s.submitterContact,
    photoCount: s._count ? s._count.photos : (s.photos ? s.photos.length : 0),
    createdAt: s.createdAt,
  };
}

module.exports = router;
