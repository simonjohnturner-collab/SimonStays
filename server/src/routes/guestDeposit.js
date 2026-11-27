// The guest agrees (or not) to a reduced deposit refund, from the link in their
// message. No account needed: the link is the key, and it only opens this.
const express = require('express');
const { bookingIdOf } = require('../utils/guestThread');
const refunds = require('../utils/depositRefunds');

const router = express.Router();
const bookingOf = (req) => bookingIdOf(req.params.token, 'guest-deposit');
const invalid = (res) => res.status(404).json({ error: 'not_found', message: 'This link isn’t valid.' });

// GET /public/deposit/:token — the deposit, what's kept back and why.
router.get('/:token', async (req, res, next) => {
  try {
    const id = bookingOf(req); if (!id) return invalid(res);
    const view = await refunds.guestView(id);
    if (!view) return invalid(res);
    res.set('Cache-Control', 'no-store');
    res.json(view);
  } catch (e) { next(e); }
});

// GET /public/deposit/:token/file/:fileId — an invoice attached to their refund.
router.get('/:token/file/:fileId', async (req, res, next) => {
  try {
    const id = bookingOf(req); if (!id) return invalid(res);
    const f = await refunds.evidenceFile(req.params.fileId, id);
    if (!f) return invalid(res);
    res.set('Content-Type', f.contentType);
    res.set('Content-Disposition', `inline; filename="${f.filename.replace(/[^\w. -]/g, '_')}"`);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(f.data));
  } catch (e) { next(e); }
});

// POST /public/deposit/:token { answer: 'agree' | 'disagree', comment }
router.post('/:token', async (req, res, next) => {
  try {
    const id = bookingOf(req); if (!id) return invalid(res);
    const r = await refunds.guestAnswer(id, req.body || {});
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message });
    res.json(r);
  } catch (e) { next(e); }
});

module.exports = router;
