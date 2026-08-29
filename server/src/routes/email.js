const express = require('express');
const prisma = require('../lib/prisma');
const { authHost } = require('../middleware/auth');
const { parseAirbnbEmail } = require('../utils/guestEmail');
const { applyGuestNames } = require('../utils/sync');

const router = express.Router();

/**
 * POST /email/ingest  { subject, body }
 * Parse an Airbnb reservation email → store code→name → back-fill any matching
 * bookings so the board shows the real guest immediately.
 *
 * This same handler is what a production inbound-email webhook (SendGrid Inbound
 * Parse / Mailgun / Cloudflare Email Worker) would POST to, so hosts can just
 * auto-forward Airbnb mail from Outlook/Gmail and names appear hands-free.
 */
router.post('/ingest', authHost, async (req, res) => {
  const { subject, body } = req.body || {};
  if (!subject && !body) return res.status(400).json({ error: 'email_required' });

  const parsed = parseAirbnbEmail({ subject, body });
  if (!parsed.resCode) return res.status(422).json({ error: 'no_reservation_code_found', parsed });
  if (!parsed.guestName) return res.status(422).json({ error: 'no_guest_name_found', parsed });

  await prisma.guestLookup.upsert({
    where: { hostId_resCode: { hostId: req.hostId, resCode: parsed.resCode } },
    update: { guestName: parsed.guestName, phoneLast4: parsed.phoneLast4 || undefined },
    create: { hostId: req.hostId, resCode: parsed.resCode, guestName: parsed.guestName, phoneLast4: parsed.phoneLast4 || null },
  });

  const updatedBookings = await applyGuestNames(req.hostId, parsed.resCode);
  res.json({ resCode: parsed.resCode, guestName: parsed.guestName, phoneLast4: parsed.phoneLast4, updatedBookings });
});

module.exports = router;
