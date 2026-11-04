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
//         guestPhone, billing, quote, method, proofUrl, split, owingCents, eft, hostName,
//         business: the host's own details (BillerProfile) }
function invoiceHtml(data) {
  const q = data.quote || {};
  const biz = data.business || {};
  const hostBlock = [
    biz.companyName && `<b>${esc(biz.companyName)}</b>${biz.registrationNo ? ` (registration number ${esc(biz.registrationNo)})` : ''}`,
    biz.addressLines && esc(biz.addressLines).replace(/\n/g, ', '),
    [biz.email, biz.phone, biz.website].filter(Boolean).map(esc).join(' &middot; '),
  ].filter(Boolean).join('<br>');
  const lines = [];
  lines.push(row(`${q.nights} night${q.nights > 1 ? 's' : ''} @ ${rand(q.avgNightlyCents)}`, rand(q.accommodationCents)));
  if (q.discountCents) lines.push(row(`${q.discountPercent}% length discount`, '&minus;' + rand(q.discountCents)));
  if (q.cleaningCents) lines.push(row('Cleaning fee', rand(q.cleaningCents)));
  if (q.earlyCents) lines.push(row('Early check-in', rand(q.earlyCents)));
  if (q.lateCents) lines.push(row('Late checkout', rand(q.lateCents)));
  lines.push(row('Rental subtotal', rand(q.rentalCents), { top: true }));
  if (q.depositCents) lines.push(row('Refundable breakage deposit', rand(q.depositCents)));
  if (data.adminFeeCents) lines.push(row('50/50 split admin fee', rand(data.adminFeeCents)));
  const payable = (q.totalCents || 0) + (data.adminFeeCents || 0);
  lines.push(row('Total payable', rand(payable), { strong: true, top: true }));
  if (data.split) {
    const now = Math.round(payable / 2);
    lines.push(row('Pay now (50%)', rand(now)));
    lines.push(row('Due at least 3 days before check-in (50%)', rand(payable - now)));
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
    + '<br><span style="color:#6b7280">Use exactly this reference on your payment, then send us your proof of payment. Your booking is confirmed, and your dates held, once your payment reaches our account.</span>'
    + (data.proofUrl ? `<br><a href="${esc(data.proofUrl)}" style="color:#1a7a3a;font-weight:700">Upload your proof of payment</a>` : '')
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
        <div style="color:#6b7280;font-size:13px">${data.awaitingPayment ? 'Invoice' : 'Booking confirmation &amp; invoice'}</div></div>
      <div style="text-align:right"><div style="font-weight:700">${esc(data.ref)}</div>
        <div style="color:#6b7280;font-size:13px">${new Date().toLocaleDateString('en-ZA')}</div></div>
    </div>

    ${data.awaitingPayment ? `<div style="margin-top:16px;padding:12px 14px;background:#fff7e6;border:1px solid #f0d9a8;border-radius:10px;font-size:14px;line-height:1.6">
      <div style="font-weight:700;color:#8a5a00">⏳ Your booking is awaiting payment</div>
      Thank you${data.guestName ? ', ' + esc(String(data.guestName).split(' ')[0]) : ''}! Your dates aren't held until your payment comes through. We'll email you as soon as your booking is confirmed.
    </div>` : `<div style="margin-top:16px;padding:12px 14px;background:#eef6f0;border:1px solid #cfe6d6;border-radius:10px;font-size:14px;line-height:1.6">
      <div style="font-weight:700;color:#1f7a44">✅ Your booking is confirmed</div>
      Thank you${data.guestName ? ', ' + esc(String(data.guestName).split(' ')[0]) : ''}! We look forward to hosting you.
    </div>`}

    <div style="margin-top:16px;font-size:14px;line-height:1.7">
      <div><b>${esc(data.propertyName)}</b> &middot; Unit ${esc(data.unitName)}</div>
      <div style="color:#374151">📅 <b>Check-in:</b> ${esc(data.checkIn)} from <b>${esc(data.checkInTime || '15:00')}</b></div>
      <div style="color:#374151">📅 <b>Check-out:</b> ${esc(data.checkOut)} by <b>${esc(data.checkOutTime || '10:00')}</b></div>
      <div style="color:#374151">🔖 <b>Booking reference:</b> ${esc(data.ref)}</div>
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

    ${data.cancellationPolicy ? `<h3 style="margin:20px 0 4px;font-size:14px">Booking rules &amp; cancellation policy</h3>
    <div style="font-size:13px;line-height:1.6;color:#374151;background:#f7f8fa;border:1px solid #e3e3e3;border-radius:8px;padding:10px 12px;white-space:pre-line">${esc(data.cancellationPolicy)}</div>` : ''}

    <div style="margin-top:18px;padding:12px 14px;background:#f6f7f9;border:1px solid #e3e3e3;border-radius:10px;font-size:13px;line-height:1.6">
      ${hostBlock ? `<b>Questions about your stay?</b> Your host is here to help:<div style="margin-top:6px">${hostBlock}</div>` : `<b>Questions about your stay?</b> Just reply to this email or reach us on the contact details below — we're happy to help.`}
    </div>

    <div style="margin-top:20px;color:#6b7280;font-size:12px;line-height:1.6;border-top:1px solid #eee;padding-top:12px">
      SimonStays is a trading name owned, controlled and managed by Catwalk Investments (registration number 1999/010697/07).<br>
      support@simonstays.co.za &middot; 078 511 9336 &middot; 23 Firenza, Pam Road, Benmore Gardens
    </div>
  </div>
</div>
</body></html>`;
}

module.exports = { invoiceHtml };
