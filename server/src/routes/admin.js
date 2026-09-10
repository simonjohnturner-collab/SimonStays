// SimonStays super-admin: only the admin account (see requireAdmin) may list
// every host and mint a token to sign in as any of them ("impersonate"). Once
// signed in as a host, the whole app is scoped to that host by their JWT, so
// the admin sees exactly what that host sees — properties, calendar, pricing,
// payouts, everything.
const express = require('express');
const prisma = require('../lib/prisma');
const { sign } = require('../lib/jwt');
const { authHost, requireAdmin, isAdminEmail } = require('../middleware/auth');

const router = express.Router();
router.use(authHost, requireAdmin);

// GET /admin/hosts — every host with a few headline counts.
router.get('/hosts', async (req, res) => {
  const hosts = await prisma.host.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      _count: { select: { properties: true, bookings: true, invoices: true } },
      properties: { select: { _count: { select: { units: true } } } },
    },
  });
  res.json({
    hosts: hosts.map((h) => ({
      id: h.id,
      email: h.email,
      name: h.name,
      contactPhone: h.contactPhone,
      createdAt: h.createdAt,
      isAdmin: isAdminEmail(h.email),
      hasPayout: !!(h.payoutAccountNumber || h.payoutBankName),
      counts: {
        properties: h._count.properties,
        units: h.properties.reduce((n, p) => n + p._count.units, 0),
        bookings: h._count.bookings,
        invoices: h._count.invoices,
      },
    })),
  });
});

// POST /admin/impersonate/:hostId — a normal host token for that host.
router.post('/impersonate/:hostId', async (req, res) => {
  const host = await prisma.host.findUnique({ where: { id: req.params.hostId } });
  if (!host) return res.status(404).json({ error: 'host_not_found' });
  res.json({
    token: sign(host),
    host: { id: host.id, email: host.email, name: host.name },
  });
});

module.exports = router;
