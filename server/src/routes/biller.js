const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');

const router = express.Router();
router.use(authHost);

const FIELDS = ['companyName', 'registrationNo', 'addressLines', 'email', 'phone',
  'bankName', 'accountNumber', 'branch', 'swiftCode', 'paymentInstruction', 'specialConditions'];

// GET /biller — the host's invoice-from profile (creates an empty one if missing).
router.get('/', async (req, res) => {
  const biller = await prisma.billerProfile.findUnique({ where: { hostId: req.hostId } });
  res.json({ biller: biller || { hostId: req.hostId } });
});

// PUT /biller — upsert the profile.
router.put('/', async (req, res) => {
  const data = {};
  FIELDS.forEach((k) => { if (k in (req.body || {})) data[k] = req.body[k]; });
  const biller = await prisma.billerProfile.upsert({
    where: { hostId: req.hostId },
    update: data,
    create: { hostId: req.hostId, ...data },
  });
  res.json({ biller });
});

module.exports = router;
