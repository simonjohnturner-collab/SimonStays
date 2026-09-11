// Builds the HTML invoice we email to a guest after they book on the shopfront.
// Mirrors the breakdown shown on the site (see stay.html breakdownLines).
function rand(c) { return 'R' + ((c || 0) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

function row(label, value, opts) {
  const st = opts && opts.strong ? 'font-weight:700;' : '';
  const bt = opts && opts.top ? 'border-top:1px solid #e3e3e3;' : '';
  return `<tr style="${bt}"><td style="padding:6px 0;${st}">${esc(label)}</td><td style="padding:6px 0;text-align:right;${st}">${value}</td></tr>`;
}

// data: { ref, propertyName, unitName, checkIn, checkOut, guestName, guestEmail,
//         guestPhone, billing, quote, method, split, owingCents, eft, hostName }
function invoiceHtml(data) {
  const q = data.quote || {};
  const lines = [];
  lines.push(row(`${q.nights} night${q.nights > 1 ? 's' : ''} @ ${rand(q.avgNightlyCents)}`, rand(q.accommodationCents)));
  if (q.discountCents) lines.push(row(`${q.discountPercent}% length discount`, '&minus;' + rand(q.discountCents)));
  if (q.cleaningCents) lines.push(row('Cleaning fee', rand(q.cleaningCents)));
  if (q.earlyCents) lines.push(row('Early check-in', rand(q.earlyCents)));
  if (q.lateCents) lines.push(row('Late checkout', rand(q.lateCents)));
  lines.push(row('Rental subtotal', rand(q.rentalCents), { top: true }));
  if (q.depositCents) lines.push(row('Refundable breakage deposit', rand(q.depositCents)));
  lines.push(row('Total payable', rand(q.totalCents), { strong: true, top: true }));
  if (data.split && data.owingCents) {
    lines.push(row('Pay now (50%)', rand(q.totalCents - data.owingCents)));
    lines.push(row('Due 3 days before check-in (50%)', rand(data.owingCents)));
  }

  const payLine = data.method === 'EFT'
    ? 'Payment method: EFT / bank transfer or deposit'
    : 'Payment method: Card (online)';

  const eft = data.eft;
  const eftBlock = (data.method === 'EFT' && eft) ? (
    '<div style="margin-top:16px;padding:12px 14px;background:#f7f8fa;border:1px solid #e3e3e3;border-radius:8px;font-size:13px;line-height:1.6">'
    + '<b>EFT / bank transfer or deposit</b><br>'
    + [eft.accountName && ('Account name: ' + esc(eft.accountName)),
      eft.bankName && ('Bank: ' + esc(eft.bankName)),
      eft.accountNumber && ('Account no.: ' + esc(eft.accountNumber)),
      eft.branch && ('Branch: ' + esc(eft.branch))].filter(Boolean).join('<br>')
    + `<br><b>Reference: ${esc(data.ref)}</b>`
    + '<br><span style="color:#6b7280">Use the booking reference as your payment reference and send proof of payment — your booking is confirmed once it&rsquo;s received.</span>'
    + '</div>'
  ) : '';

  const billBlock = data.billing
    ? `<div style="margin-top:4px;color:#374151;white-space:pre-line">${esc(data.billing)}</div>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f2f3f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2430">
<div style="max-width:640px;margin:0 auto;padding:24px">
  <div style="background:#fff;border:1px solid #e3e3e3;border-radius:14px;padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div><div style="font-size:22px;font-weight:800;color:#2e7d5b">Simon<span style="color:#1f2430">Stays</span></div>
        <div style="color:#6b7280;font-size:13px">Booking invoice</div></div>
      <div style="text-align:right"><div style="font-weight:700">${esc(data.ref)}</div>
        <div style="color:#6b7280;font-size:13px">${new Date().toLocaleDateString('en-ZA')}</div></div>
    </div>

    <div style="margin-top:18px;font-size:14px;line-height:1.6">
      <div><b>${esc(data.propertyName)}</b> &middot; Unit ${esc(data.unitName)}</div>
      <div style="color:#374151">Check-in <b>${esc(data.checkIn)}</b> &rarr; Check-out <b>${esc(data.checkOut)}</b></div>
    </div>

    <h3 style="margin:18px 0 4px;font-size:14px">Billed to</h3>
    <div style="font-size:14px;line-height:1.6">
      <div><b>${esc(data.guestName)}</b></div>
      ${data.guestEmail ? `<div>${esc(data.guestEmail)}</div>` : ''}
      ${data.guestPhone ? `<div>${esc(data.guestPhone)}</div>` : ''}
      ${billBlock}
    </div>

    <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px">${lines.join('')}</table>

    <div style="margin-top:14px;color:#374151;font-size:13px">${payLine}${data.split ? ' &middot; 50/50 split' : ''}</div>
    ${eftBlock}

    <div style="margin-top:20px;color:#6b7280;font-size:12px;line-height:1.6;border-top:1px solid #eee;padding-top:12px">
      SimonStays is a trading name owned, controlled and managed by Catwalk Investments (registration number 1999/010697/07).<br>
      support@simonstays.com &middot; 078 511 9336 &middot; 23 Firenza, Pam Road, Benmore Gardens
    </div>
  </div>
</div>
</body></html>`;
}

module.exports = { invoiceHtml };
