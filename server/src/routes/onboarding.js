// A new host's "Getting started" checklist: the steps to get a listing live,
// each ticked off from what's actually set up. Shown on Today until done.
// The same steps, in more detail, are on the public guide (/host/guide).
const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

// GET /onboarding — the steps, in order, with whether each is done.
router.get('/', async (req, res, next) => {
  try {
    const hostId = req.hostId;
    const [props, biller, providers, schedules, bubbles] = await Promise.all([
      prisma.property.findMany({
        where: { hostId, kind: 'stay' },
        select: { description: true, latitude: true, _count: { select: { photos: true } },
          units: { select: { pricingGroupId: true, _count: { select: { photos: true, channels: { where: { importUrl: { not: null } } } } } } } },
      }),
      prisma.billerProfile.findUnique({ where: { hostId }, select: { bankName: true, accountNumber: true } }),
      prisma.serviceProvider.count({ where: { hostId } }),
      prisma.messageSchedule.count({ where: { hostId } }),
      prisma.bubbleMember.count({ where: { hostId } }),
    ]);
    const units = props.flatMap((p) => p.units);
    const photos = props.reduce((n, p) => n + p._count.photos + p.units.reduce((m, u) => m + u._count.photos, 0), 0);
    const steps = [
      { key: 'property', title: 'Add your property and its units', how: 'A property is the building or house; each unit is one place guests book.', to: '/listings', done: units.length > 0 },
      { key: 'photos', title: 'Upload your photos', how: 'Bright, landscape photos of every room. Star your best one as the cover.', to: '/listings', done: photos >= 5 },
      { key: 'describe', title: 'Describe it and drop the map pin', how: 'What’s special, what’s nearby, then click the map to place your pin.', to: '/listings', done: props.some((p) => (p.description || '').trim().length >= 80 && p.latitude != null) },
      { key: 'pricing', title: 'Set your prices', how: 'Create a pricing group (nightly rate, cleaning, discounts, deposit) and assign your units.', to: '/listings/pricing', done: units.length > 0 && units.every((u) => u.pricingGroupId) },
      { key: 'calendar', title: 'Link your Airbnb calendar', how: 'Paste each unit’s Airbnb calendar link, so a night sold there closes here.', to: '/listings', done: units.length > 0 && units.every((u) => u._count.channels > 0) },
      { key: 'bank', title: 'Add your bank details', how: 'So we can pay you out, and so they show on your invoices.', to: '/money/billing', done: !!(biller && (biller.bankName || biller.accountNumber)) },
      { key: 'cleaners', title: 'Add your cleaners', how: 'They get a WhatsApp reminder the night before each checkout.', to: '/team', done: providers > 0 },
      { key: 'messages', title: 'Set up guest messages', how: 'A welcome, check-in details and your guestbook link, sent automatically.', to: '/inbox/scheduled', done: schedules > 0 },
      { key: 'bubble', title: 'Join a pricing bubble (optional)', how: 'Your price rises when the area is busy and drops when it’s quiet.', to: '/listings/bubbles', done: bubbles > 0, optional: true },
    ];
    res.json({ steps, done: steps.filter((s) => !s.optional).every((s) => s.done) });
  } catch (e) { next(e); }
});

module.exports = router;
