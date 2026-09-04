// Admin (auth) API for Forms: design the questions (one Damage form + any
// number of Checkout-clean forms, each scoped to a set of units) and
// review/search the completed submissions.
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const { defaultTemplate } = require('../utils/formDefaults');

const router = express.Router();
router.use(authHost);

// ---- Form design ----

// GET /forms/templates → the single Damage form + all Clean forms.
router.get('/templates', async (req, res) => {
  const all = await prisma.formTemplate.findMany({ where: { hostId: req.hostId }, orderBy: { createdAt: 'asc' } });
  const damage = all.find((t) => t.type === 'damage') || { ...defaultTemplate('damage'), id: null, name: 'Damage report', unitIds: [], hostId: req.hostId, unsaved: true };
  const cleanForms = all.filter((t) => t.type === 'clean');
  res.json({ damage, cleanForms });
});

// PUT /forms/templates/damage — upsert the single damage form.
router.put('/templates/damage', async (req, res) => {
  const b = req.body || {};
  const data = {
    title: b.title || defaultTemplate('damage').title,
    description: b.description || null,
    fields: Array.isArray(b.fields) ? b.fields : [],
    active: b.active !== false,
  };
  const existing = await prisma.formTemplate.findFirst({ where: { hostId: req.hostId, type: 'damage' } });
  const template = existing
    ? await prisma.formTemplate.update({ where: { id: existing.id }, data })
    : await prisma.formTemplate.create({ data: { hostId: req.hostId, type: 'damage', name: 'Damage report', unitIds: [], ...data } });
  res.json({ template });
});

// POST /forms/clean-forms — create a checkout-clean form.
router.post('/clean-forms', async (req, res) => {
  const b = req.body || {};
  const template = await prisma.formTemplate.create({
    data: {
      hostId: req.hostId, type: 'clean',
      name: b.name || 'Checkout clean',
      unitIds: Array.isArray(b.unitIds) ? b.unitIds : [],
      title: b.title || 'Checkout clean report',
      description: b.description || null,
      fields: Array.isArray(b.fields) ? b.fields : [],
      active: b.active !== false,
    },
  });
  res.status(201).json({ template });
});

// PUT /forms/clean-forms/:id — update a checkout-clean form.
router.put('/clean-forms/:id', async (req, res) => {
  const existing = await prisma.formTemplate.findFirst({ where: { id: req.params.id, hostId: req.hostId, type: 'clean' } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const data = {};
  if ('name' in b) data.name = b.name || 'Checkout clean';
  if ('unitIds' in b) data.unitIds = Array.isArray(b.unitIds) ? b.unitIds : [];
  if ('title' in b) data.title = b.title || 'Checkout clean report';
  if ('description' in b) data.description = b.description || null;
  if ('fields' in b) data.fields = Array.isArray(b.fields) ? b.fields : [];
  if ('active' in b) data.active = b.active !== false;
  const template = await prisma.formTemplate.update({ where: { id: existing.id }, data });
  res.json({ template });
});

// DELETE /forms/clean-forms/:id
router.delete('/clean-forms/:id', async (req, res) => {
  const existing = await prisma.formTemplate.findFirst({ where: { id: req.params.id, hostId: req.hostId, type: 'clean' }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  await prisma.formTemplate.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

// ---- Submissions (search + review) ----

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
    include: { property: { select: { name: true } }, unit: { select: { name: true } }, _count: { select: { photos: true } } },
    take: Math.min(Number(req.query.limit) || 300, 300),
  });
  res.json({ submissions: subs.map(fmtSub) });
});

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

router.patch('/submissions/:id', async (req, res) => {
  const sub = await prisma.formSubmission.findFirst({ where: { id: req.params.id, hostId: req.hostId }, select: { id: true } });
  if (!sub) return res.status(404).json({ error: 'not_found' });
  const data = {};
  if ('status' in (req.body || {})) data.status = req.body.status;
  const updated = await prisma.formSubmission.update({ where: { id: sub.id }, data });
  res.json({ submission: { id: updated.id, status: updated.status } });
});

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
