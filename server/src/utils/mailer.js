// Outbound email. With RESEND_API_KEY set it sends through Resend's web API, which
// works where a host blocks SMTP ports. Otherwise SMTP via nodemailer, configured
// from env; if nothing is set it falls back to the Zoho account already used for
// IMAP ingest, so invoices can send without new credentials. All failures are
// swallowed + logged so a mail problem never breaks a booking.
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
  fromAddress = process.env.SMTP_FROM || process.env.MAIL_FROM || 'SimonStays <support@simonstays.co.za>';

  if (!host || !user || !pass) {
    console.warn('[mailer] SMTP not configured — invoice emails will be skipped. Set SMTP_HOST/SMTP_USER/SMTP_PASSWORD/SMTP_FROM (or Zoho IMAP creds).');
    return;
  }
  transporter = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass },
    // A send happens while someone waits on screen, so give up quickly if the server can't be reached.
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  console.log(`[mailer] SMTP ready via ${host}:${port} as ${fromAddress}`);
}

const RESEND_KEY = () => process.env.RESEND_API_KEY || null;
function isEnabled() { init(); return !!(RESEND_KEY() || transporter); }

async function sendViaResend({ to, subject, html, text, replyTo, attachments }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      from: fromAddress, to, subject, html, text, reply_to: replyTo || undefined,
      attachments: attachments ? attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) : undefined,
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/** Send an email. Returns true on success, false if skipped/failed (never throws). */
async function sendMail({ to, subject, html, text, replyTo, attachments }) {
  init();
  if (!to) return false;
  if (RESEND_KEY()) {
    try { await sendViaResend({ to, subject, html, text, replyTo, attachments }); return true; }
    catch (e) { console.error('[mailer] send failed:', e.message); return false; }
  }
  if (!transporter) return false;
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
