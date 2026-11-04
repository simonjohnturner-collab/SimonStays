// The guest's invoice as an email, in the same old-paper style as the admin portal.
// Built from tables and inline styles, as email programs ignore most other styling.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rand = (c) => `${c < 0 ? '-' : ''}R${(Math.abs(c) / 100).toFixed(2)}`;

const INK = '#23356f';
const HAND = "'Segoe Print','Bradley Hand','Comic Sans MS',cursive";
const TYPE = "'Courier New',Courier,monospace";
const LINK_TEXT = 'Click on this link to follow all relevant messages pertaining to your booking.';

const stampOf = (paidCents, owing) => {
  if (owing > 0 && paidCents > 0) return { text: 'PART PAID', color: '#b3261e' };
  if (paidCents > 0) return { text: 'PAID', color: '#1b7a43' };
  return { text: 'UNPAID', color: '#b3261e' };
};

const SIGNUP_TEXT = 'All communication will be sent inside SimonStays, so you need to set up an account to see your communications.';

// i: { ref, date, guestName, place, address, checkIn, checkOut, lines, totalCents, method, paidCents, owingCents, link, signupLink }
// signupLink is for a guest with no account yet.
function paperInvoiceEmail(i) {
  const stamp = stampOf(i.paidCents, i.owingCents);
  const line = (l) => `<tr><td style="padding:6px 0;border-bottom:1px solid #d3cbb8;font-family:${HAND};font-size:14px;color:${INK}">${esc(l.description)}</td><td align="right" style="padding:6px 0 6px 14px;border-bottom:1px solid #d3cbb8;font-family:${HAND};font-size:14px;color:${INK};white-space:nowrap">${rand(l.amountCents)}</td></tr>` +
    (l.nights || []).map((n) => `<tr><td style="padding:1px 0 1px 18px;font-family:${HAND};font-size:12px;color:${INK}">${esc(n.date)}${n.note ? ` (${esc(n.note)})` : ''}</td><td align="right" style="padding:1px 0 1px 14px;font-family:${HAND};font-size:12px;color:${INK};white-space:nowrap">${rand(n.cents)}</td></tr>`).join('');
  const to = (label, value) => (value ? `<tr><td valign="top" style="padding:1px 10px 1px 0;font-family:${TYPE};font-size:12px;color:${INK};white-space:nowrap">${esc(label)}</td><td style="padding:1px 0;font-family:${HAND};font-size:14px;color:${INK}">${esc(value)}</td></tr>` : '');
  const foot = (label, value, strong) => `<tr><td style="padding:6px 0;font-family:${HAND};font-size:${strong ? 15 : 14}px;color:${INK};${strong ? 'font-weight:700;border-top:2px solid ' + INK + ';border-bottom:3px double ' + INK + ';' : 'border-bottom:1px solid #d3cbb8;'}">${esc(label)}</td><td align="right" style="padding:6px 0 6px 14px;font-family:${HAND};font-size:${strong ? 15 : 14}px;color:${INK};white-space:nowrap;${strong ? 'font-weight:700;border-top:2px solid ' + INK + ';border-bottom:3px double ' + INK + ';' : 'border-bottom:1px solid #d3cbb8;'}">${rand(value)}</td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:16px 8px;background:#eceae4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#f7efd9;border:1px solid #d8cdb0;border-left:4px solid #cf8f8f">
<tr><td style="padding:24px 26px 20px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:3px double ${INK}"><tr>
    <td valign="top" style="padding-bottom:10px;font-family:${TYPE};font-size:13px;line-height:1.4;color:${INK}"><div style="font-size:24px;font-weight:700">SimonStays</div>support@simonstays.co.za<br>078 511 9336</td>
    <td valign="top" align="right" style="padding-bottom:10px;font-family:${TYPE};font-size:13px;line-height:1.4;color:${INK}"><div style="font-size:20px;font-weight:700;letter-spacing:4px">INVOICE</div>No. ${esc(i.ref || '-')}<br>Date: ${esc(i.date)}</td>
  </tr></table>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0 10px">
    ${to('Bill to:', i.guestName)}${to('For:', i.place)}${to('Address:', i.address)}${to('Check-in:', i.checkIn)}${to('Check-out:', i.checkOut)}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:5px 0;border-top:1px solid ${INK};border-bottom:1px solid ${INK};font-family:${TYPE};font-size:12px;font-weight:700;color:${INK}">Description</td><td align="right" style="padding:5px 0;border-top:1px solid ${INK};border-bottom:1px solid ${INK};font-family:${TYPE};font-size:12px;font-weight:700;color:${INK}">Amount</td></tr>
    ${i.lines.map(line).join('')}
    ${foot('Total', i.totalCents, true)}
    ${i.paidCents > 0 ? foot(`Paid by ${i.method}`, i.paidCents) : ''}
    ${i.owingCents > 0 ? foot('Balance due', i.owingCents, true) : ''}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr>
    <td valign="middle" style="font-family:${HAND};font-size:13px;color:${INK}">Thank you for staying with us!</td>
    <td valign="middle" align="right"><span style="display:inline-block;padding:3px 12px;border:3px solid ${stamp.color};border-radius:6px;color:${stamp.color};font-family:${TYPE};font-size:22px;font-weight:700;letter-spacing:3px;transform:rotate(-8deg)">${stamp.text}</span></td>
  </tr></table>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px"><tr><td style="padding:18px 8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;text-align:center;color:#1d2433">
  <a href="${esc(i.link)}" style="color:#1a7a3a;font-weight:700">${LINK_TEXT}</a>
  <div style="margin-top:8px;font-size:13px;color:#6b7280">This link is private to you, so please don't share it. You can also reply to this email to reach us.</div>
  ${i.signupLink ? `<div style="margin-top:16px;font-size:15px;font-weight:700;color:#c0141a">${SIGNUP_TEXT} <a href="${esc(i.signupLink)}" style="color:#c0141a">Set up your account</a></div>` : ''}
</td></tr></table>
</td></tr></table>
</body></html>`;

  const text = [
    `SimonStays · support@simonstays.co.za · 078 511 9336`,
    `INVOICE No. ${i.ref || '-'} · ${i.date}`,
    '',
    `Bill to: ${i.guestName || ''}`,
    `For: ${i.place || ''}`,
    ...(i.address ? [`Address: ${i.address}`] : []),
    `Check-in: ${i.checkIn}`,
    ...(i.checkOut ? [`Check-out: ${i.checkOut}`] : []),
    '',
    ...i.lines.map((l) => `${l.description}: ${rand(l.amountCents)}`),
    '',
    `Total: ${rand(i.totalCents)}`,
    ...(i.paidCents > 0 ? [`Paid by ${i.method}: ${rand(i.paidCents)}`] : []),
    ...(i.owingCents > 0 ? [`Balance due: ${rand(i.owingCents)}`] : []),
    '',
    LINK_TEXT,
    i.link,
    ...(i.signupLink ? ['', SIGNUP_TEXT, `Set up your account: ${i.signupLink}`] : []),
  ].join('\n');
  return { html, text };
}

module.exports = { paperInvoiceEmail };
