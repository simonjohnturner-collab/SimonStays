// Outbound email (SMTP via nodemailer). Configured from env; if nothing is set
// it falls back to the Zoho account already used for IMAP ingest, so invoices
// can send without new credentials. All failures are swallowed + logged so a
// mail problem never breaks a booking.
const nodemailer = require('nodemailer');

let transporter = null;
let fromAddress = null;
let configured = false;

function init() {
  if (configured) return;
  configured = true;

  // Explicit SMTP config wins; otherwise reuse the Zoho IMAP credentials.
  const host = process.env.SMTP_HOST || (process.env.ZOHO_IMAP_USER ? 'smtp.zoho.com' : null);
  const user = process.env.SMTP_USER || process.env.ZOHO_IMAP_USER || null;
  const pass = process.env.SMTP_PASSWORD || process.env.ZOHO_IMAP_PASSWORD || null;
  const port = Number(process.env.SMTP_PORT || 465);
  fromAddress = process.env.SMTP_FROM || process.env.MAIL_FROM || user || null;

  if (!host || !user || !pass) {
    console.warn('[mailer] SMTP not configured — invoice emails will be skipped. Set SMTP_HOST/SMTP_USER/SMTP_PASSWORD/SMTP_FROM (or Zoho IMAP creds).');
    return;
  }
  transporter = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass },
  });
  console.log(`[mailer] SMTP ready via ${host}:${port} as ${fromAddress}`);
}

function isEnabled() { init(); return !!transporter; }

/** Send an email. Returns true on success, false if skipped/failed (never throws). */
async function sendMail({ to, subject, html, text, replyTo, attachments }) {
  init();
  if (!transporter) return false;
  if (!to) return false;
  try {
    await transporter.sendMail({
      from: fromAddress, to, subject, html, text,
      replyTo: replyTo || undefined,
      attachments: attachments || undefined,
    });
    return true;
  } catch (e) {
    console.error('[mailer] send failed:', e.message);
    return false;
  }
}

module.exports = { sendMail, isEnabled };
