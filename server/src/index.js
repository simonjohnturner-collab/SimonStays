require('dotenv').config();
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
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'staysync', time: new Date().toISOString() }));

// Public feed FIRST — it must not pass through the auth'd catch-all routers below.
app.use('/feed', require('./routes/feed'));

app.use('/auth', require('./routes/auth'));
app.use('/email', require('./routes/email'));
app.use('/biller', require('./routes/biller'));
app.use('/invoices', require('./routes/invoices'));
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

  const mailPoller = require('./utils/mailPoller');
  const pollExpr = process.env.ZOHO_POLL_CRON || '*/5 * * * *';
  if (mailPoller.enabled() && cron.validate(pollExpr)) {
    cron.schedule(pollExpr, async () => {
      try { const s = await mailPoller.pollOnce(); if (s.processed) console.log('[mail]', JSON.stringify(s)); }
      catch (e) { console.error('[mail] failed', e.message); }
    });
    console.log(`Zoho mail poll scheduled: ${pollExpr} (${mailPoller.config().folder})`);
  }
}

module.exports = app;
