// DRAFT — the welcome email for new hosts. Not sent anywhere yet: nothing calls
// it. To switch it on, call sendHostWelcome(host) when a hosting account is
// created (routes/auth.js register, and guestAuth become-host).
//
// It walks a new host through the 10 setup steps in short, and points to the
// full guide (/host/guide) and their Getting started checklist on Today.
const BASE = () => (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STEPS = [
  ['Add your property and units', 'Menu → Properties & units. The property is the building; each unit is a place guests book.'],
  ['Upload your photos', 'At least 10 per unit: bright, landscape, every room. Star your best one as the cover.'],
  ['Describe the place and the area', 'What makes it special, the practical bits, and what’s nearby.'],
  ['Drop the map pin', 'So guests searching your area find you.'],
  ['Fill in the practical details', 'Check-in times, Wi-Fi, parking, security, backup power.'],
  ['Set your prices', 'Menu → Pricing: a pricing group with your rates, cleaning fee, discounts and deposit.'],
  ['Link your Airbnb calendar', 'Paste each unit’s Airbnb calendar link, and add our Lock link in Airbnb, so nothing is sold twice.'],
  ['Choose how guests book', 'Instant, instant for 5-star guests, or request to book. Check your cancellation policy.'],
  ['Add your bank details and cleaners', 'So we can pay you, and your cleaners get a WhatsApp reminder before every checkout.'],
  ['Set up guest messages and go live', 'Inbox → Scheduled: a welcome, check-in details and your guestbook link.'],
];

function hostWelcomeEmail(host = {}) {
  const first = String(host.name || '').trim().split(/\s+/)[0] || 'there';
  const base = BASE();
  const subject = `Welcome to SimonStays, ${first}: let’s get your place live`;
  const text = [
    `Hi ${first},`,
    '',
    'Welcome to SimonStays. I’m Simon. I’ve been hosting apartments and houses for more than 20 years, and I built SimonStays to run my own places. Now it’s yours too.',
    '',
    'You can be live in an afternoon. Here’s the order to do it in:',
    ...STEPS.map(([t, d], i) => `${i + 1}. ${t}: ${d}`),
    '',
    'When you sign in, the Getting started checklist on your Today screen ticks off each step as you go.',
    '',
    'New: smart pricing. Add your units to a pricing bubble (Menu → Pricing bubbles) and your SimonStays prices rise when your area is busy and drop when it’s quiet, by rules you set.',
    '',
    'Cleaners: add them under Menu → Team. They get a WhatsApp reminder the night before each checkout and a photo checklist on their phone. No app needed.',
    '',
    'Ratings: guests who book on SimonStays are invited to rate their stay the day after checkout, and you can rate them in Inbox → Reviews. Want your Airbnb reviews shown too? Just reply to this email.',
    '',
    'You only pay 10% on bookings SimonStays brings you. No monthly fee, and nothing on your Airbnb bookings.',
    '',
    `The full step-by-step guide and host FAQ: ${base}/host/guide`,
    `Sign in: ${base}/hosting/`,
    '',
    'Stuck on anything? Reply to this email or WhatsApp me on 078 511 9336.',
    '',
    'Happy hosting,',
    'Simon',
    'SimonStays',
  ].join('\n');

  const btn = (href, label) => `<a href="${href}" style="display:inline-block;background:#1a7a3a;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">${label}</a>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2a24">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <div style="font-size:22px;font-weight:800;color:#1a7a3a;margin-bottom:16px">Simon<span style="color:#1f2a24">Stays</span></div>
  <div style="background:#fff;border-radius:14px;padding:28px 26px;border:1px solid #e3e6ea">
    <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25">Welcome, ${esc(first)}. Let’s get your place live.</h1>
    <p style="margin:0 0 14px;line-height:1.6">I’m Simon. I’ve been hosting apartments and houses for <b>more than 20 years</b>, and I built SimonStays to run my own places. Now it’s yours too.</p>
    <p style="margin:0 0 18px;line-height:1.6">You can be live in an afternoon. Here’s the order to do it in. When you sign in, the <b>Getting started</b> checklist on your Today screen ticks off each step as you go.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:20px">
      ${STEPS.map(([t, d], i) => `<tr><td style="vertical-align:top;padding:7px 12px 7px 0;width:30px"><div style="width:26px;height:26px;border-radius:50%;background:#1a7a3a;color:#fff;font-weight:800;font-size:13px;text-align:center;line-height:26px">${i + 1}</div></td><td style="padding:7px 0;line-height:1.5"><b>${esc(t)}</b><br><span style="color:#5b6670;font-size:14px">${esc(d)}</span></td></tr>`).join('')}
    </table>
    <p style="margin:0 0 22px">${btn(`${base}/hosting/`, 'Start setting up →')}</p>

    <div style="background:#e6f2ea;border-radius:12px;padding:16px 18px;margin-bottom:14px">
      <b style="color:#14622f">New: smart pricing</b>
      <p style="margin:6px 0 0;line-height:1.55;font-size:14px">Add your units to a pricing bubble (Menu → Pricing bubbles). Your SimonStays prices rise when your area is busy and drop when it’s quiet, by rules you set. Nobody else ever sees or changes your prices.</p>
    </div>
    <p style="margin:0 0 10px;line-height:1.55;font-size:14px"><b>Cleaners.</b> Add them under Menu → Team. They get a WhatsApp reminder the night before each checkout, and a photo checklist on their phone. No app needed.</p>
    <p style="margin:0 0 10px;line-height:1.55;font-size:14px"><b>Ratings.</b> Guests who book on SimonStays are invited to rate their stay the day after checkout, and you rate them in Inbox → Reviews. Want your Airbnb reviews shown too? Just reply to this email.</p>
    <p style="margin:0 0 18px;line-height:1.55;font-size:14px"><b>What it costs.</b> 10% of bookings SimonStays brings you. No monthly fee, and nothing on your Airbnb bookings.</p>

    <p style="margin:0 0 6px;line-height:1.55">The full step-by-step guide, with answers to the questions hosts ask:</p>
    <p style="margin:0 0 20px"><a href="${base}/host/guide" style="color:#1a7a3a;font-weight:700">Read the host guide →</a></p>
    <p style="margin:0;line-height:1.6">Stuck on anything? Reply to this email or WhatsApp me on 078 511 9336.</p>
    <p style="margin:16px 0 0;line-height:1.6">Happy hosting,<br><b>Simon</b></p>
  </div>
  <p style="font-size:12px;color:#8a949c;text-align:center;margin:16px 0 0">SimonStays is a trading name of Catwalk Investments (1999/010697/07).</p>
</div></body></html>`;
  return { subject, text, html };
}

// For when it's switched on: send it with the site mailer.
async function sendHostWelcome(host) {
  const { sendMail } = require('./mailer');
  const m = hostWelcomeEmail(host);
  return sendMail({ to: host.email, subject: m.subject, html: m.html, text: m.text });
}

module.exports = { hostWelcomeEmail, sendHostWelcome };
