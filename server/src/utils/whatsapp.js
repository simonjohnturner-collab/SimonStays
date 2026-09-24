// Minimal Twilio WhatsApp sender (no SDK dependency — raw HTTPS with Basic auth).
// Dormant-safe: with no Twilio creds, enabled() is false and sends are skipped.
//
// Env:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   — your Twilio credentials
//   TWILIO_WHATSAPP_FROM                    — your WhatsApp sender, e.g. "whatsapp:+14155238886"
//                                             (the sandbox number, or your approved business number)
//   TWILIO_WHATSAPP_CONTENT_SID (optional)  — an APPROVED WhatsApp template's Content SID. Required
//                                             for business-INITIATED messages outside the 24h window
//                                             (i.e. these reminders in production). Without it we send
//                                             a plain Body, which only lands inside the 24h session /
//                                             the Twilio sandbox.
const https = require('https');

function enabled() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
}

// Normalise a South African-friendly phone into E.164 (+27…). Accepts "072 123 4567",
// "0721234567", "+27 72 123 4567", "2772…". Returns null if it can't.
function toE164(raw, defaultCC = '27') {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return '+' + s.slice(2);
  if (s.startsWith('0')) return '+' + defaultCC + s.slice(1);
  if (s.startsWith(defaultCC)) return '+' + s;
  return '+' + s;
}

// Send a WhatsApp message. Pass `body` for a freeform message, or `contentSid` +
// `contentVariables` ({ "1": "…", "2": "…" }) to send an approved template.
function sendWhatsApp({ to, body, contentSid, contentVariables }) {
  return new Promise((resolve) => {
    if (!enabled()) return resolve({ ok: false, skipped: 'no_creds' });
    const e164 = toE164(to);
    if (!e164) return resolve({ ok: false, skipped: 'bad_number' });

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const fromRaw = process.env.TWILIO_WHATSAPP_FROM;
    const from = fromRaw.startsWith('whatsapp:') ? fromRaw : 'whatsapp:' + fromRaw;

    const form = new URLSearchParams();
    form.set('To', 'whatsapp:' + e164);
    form.set('From', from);
    const useSid = contentSid || process.env.TWILIO_WHATSAPP_CONTENT_SID;
    if (useSid) {
      form.set('ContentSid', useSid);
      if (contentVariables) form.set('ContentVariables', JSON.stringify(contentVariables));
      if (body) form.set('Body', body); // harmless fallback text
    } else {
      form.set('Body', body || '');
    }
    const payload = form.toString();

    const req = https.request({
      method: 'POST',
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch (e) { /* non-JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, sid: json && json.sid, to: e164 });
        else resolve({ ok: false, status: res.statusCode, error: (json && json.message) || data, to: e164 });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

module.exports = { enabled, toE164, sendWhatsApp };
