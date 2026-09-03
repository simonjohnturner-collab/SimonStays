require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');

const prisma = require('./lib/prisma');
const { syncAll } = require('./utils/sync');

const app = express();
app.set('trust proxy', 1); // behind Render's proxy (correct https in req.protocol)
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '12mb' })); // room for base64 photo uploads

app.get('/health', (req, res) => res.json({ ok: true, service: 'staysync', time: new Date().toISOString() }));

// Public feed FIRST — it must not pass through the auth'd catch-all routers below.
app.use('/feed', require('./routes/feed'));
// Photos: GET /photos/:id is public (image bytes); mount before the auth'd
// catch-all routers so it isn't shadowed. Its write routes auth themselves.
app.use('/photos', require('./routes/photos'));
app.use('/listings', require('./routes/listings'));
// Public shopfront API (no auth) — mount before the auth'd catch-all routers.
app.use('/public', require('./routes/public'));

// Public guest "Report an issue" page — self-contained HTML served from the
// backend so it has an instant URL and talks to /public/forms same-origin.
const FORMS_CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'";
const reportHtml = fs.readFileSync(path.join(__dirname, 'pages/report.html'), 'utf8');
const cleanHtml = fs.readFileSync(path.join(__dirname, 'pages/clean.html'), 'utf8');
app.get(['/report', '/report/damage'], (req, res) => {
  res.setHeader('Content-Security-Policy', FORMS_CSP);
  res.type('html').send(reportHtml);
});
app.get(['/clean', '/report/clean'], (req, res) => {
  res.setHeader('Content-Security-Policy', FORMS_CSP);
  res.type('html').send(cleanHtml);
});

app.use('/auth', require('./routes/auth'));
app.use('/email', require('./routes/email'));
app.use('/biller', require('./routes/biller'));
app.use('/invoices', require('./routes/invoices'));
app.use('/forms', require('./routes/forms'));
app.use('/groups', require('./routes/groups'));
app.use('/properties', require('./routes/properties'));
app.use('/units', require('./routes/units'));
// channels + bookings routers mount their own /units/:unitId/... and top-level paths
app.use('/', require('./routes/channels'));
app.use('/', require('./routes/bookings'));

// central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error', message: err.message });
});

const PORT = process.env.PORT || 4000;

// Only start the HTTP server + scheduler when run directly (not when required by tests).
if (require.main === module) {
  app.listen(PORT, () => console.log(`StaySync API on :${PORT}`));

  const expr = process.env.SYNC_CRON || '*/30 * * * *';
  if (cron.validate(expr)) {
    cron.schedule(expr, async () => {
      try {
        const results = await syncAll();
        console.log(`[sync] ${results.length} unit(s) synced`);
      } catch (e) { console.error('[sync] failed', e.message); }
    });
    console.log(`Channel sync scheduled: ${expr}`);
  }

  // Scheduled mail polling is OPT-IN (ENABLE_MAIL_CRON=true) so it never runs on
  // local dev by default — otherwise a dev box would consume the shared Zoho
  // mailbox before the live site sees the emails. On live, guest-name polling is
  // driven by the Sync button instead (POST /email/poll), which is reliable on a
  // free instance that sleeps. Set ENABLE_MAIL_CRON=true only for an always-on host.
  const mailPoller = require('./utils/mailPoller');
  const pollExpr = process.env.ZOHO_POLL_CRON || '*/5 * * * *';
  if (process.env.ENABLE_MAIL_CRON === 'true' && mailPoller.enabled() && cron.validate(pollExpr)) {
    cron.schedule(pollExpr, async () => {
      try { const s = await mailPoller.pollOnce(); if (s.processed) console.log('[mail]', JSON.stringify(s)); }
      catch (e) { console.error('[mail] failed', e.message); }
    });
    console.log(`Zoho mail poll scheduled: ${pollExpr} (${mailPoller.config().folder})`);
  }
}

module.exports = app;
