import { useState } from 'react';
import { api } from '../api.js';
import { fmtR, randToCents, centsToRand } from '../money.js';

// Nights between two YYYY-MM-DD dates (checkout exclusive). null if not both valid.
function nightsBetween(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(a || '') || !/^\d{4}-\d{2}-\d{2}/.test(b || '')) return null;
  const n = Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
  return n > 0 ? n : null;
}

// A line is either a 'stay' (In/Out dates x nightly rate) or a once-off 'charge'
// (deposit, cleaning, ...) with just an amount. Older invoices have no kind stored:
// a line with dates (or the first line) is a stay, anything else a charge.
function lineKind(l, i) {
  if (l.kind === 'stay' || l.kind === 'charge') return l.kind;
  return l.dateIn || l.dateOut || i === 0 ? 'stay' : 'charge';
}

// Rand amount input: shows "R 52 500.00" until focused, then the plain number for editing.
function MoneyInput({ value, onChange, className = 'num' }) {
  const [editing, setEditing] = useState(false);
  const shown = editing || value === '' || value == null ? value : fmtR(randToCents(value));
  return (
    <input className={className} value={shown} placeholder="R 0.00"
      onFocus={() => setEditing(true)} onBlur={() => setEditing(false)}
      onChange={(e) => onChange(e.target.value)} />
  );
}

// Description grows to fit its text so long descriptions are never cut off.
const autoGrow = (el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } };

// Editable, printable invoice document. Inputs look like plain text and lose
// their borders when printed, so the same view edits and prints cleanly.
export default function InvoiceEditor({ invoice, biller, onSaved, onDeleted, onDuplicated, onEditBiller }) {
  const B = invoice.billerSnapshot || biller || {};
  const [date, setDate] = useState((invoice.date || '').slice(0, 10));
  const [invoiceType, setInvoiceType] = useState(invoice.invoiceType || 'Accommodation');
  const [bill, setBill] = useState({
    name: invoice.billToName || '', address: invoice.billToAddress || '',
    attention: invoice.billToAttention || '', email: invoice.billToEmail || '', phone: invoice.billToPhone || '',
  });
  const [lines, setLines] = useState((invoice.lineItems || []).map((l, i) => {
    const kind = lineKind(l, i);
    return kind === 'stay'
      ? { kind, description: l.description || '', dateIn: l.dateIn || '', dateOut: l.dateOut || '',
          qty: l.qty ?? '', nightly: centsToRand(l.nightlyCents), amount: centsToRand(l.amountCents) }
      : { kind, description: l.description || '', dateIn: '', dateOut: '', qty: '', nightly: '', amount: centsToRand(l.amountCents) };
  }));
  const [discountPercent, setDiscountPercent] = useState(invoice.discountPercent || 0);
  const [dueNow, setDueNow] = useState(centsToRand(invoice.dueNowCents));
  const [paid, setPaid] = useState(invoice.paidCents ? centsToRand(invoice.paidCents) : '');
  const [special, setSpecial] = useState(invoice.specialConditions || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const lineCents = (l) => (l.kind === 'stay' && Number(l.nightly) > 0 ? Math.round((Number(l.qty) || 0) * Number(l.nightly) * 100) : randToCents(l.amount));
  const subtotal = lines.reduce((s, l) => s + lineCents(l), 0);
  const discountCents = Math.round(subtotal * (Number(discountPercent) || 0) / 100);
  const totalCents = subtotal - discountCents;
  const paidCents = randToCents(paid);
  const outstandingCents = totalCents - paidCents;

  const setB = (k, v) => setBill({ ...bill, [k]: v });
  const setLine = (i, k, v) => setLines(lines.map((l, j) => {
    if (j !== i) return l;
    const nl = { ...l, [k]: v };
    if (k === 'dateIn' || k === 'dateOut') { const n = nightsBetween(nl.dateIn, nl.dateOut); if (n != null) nl.qty = n; }
    return nl;
  }));
  const addLine = (kind) => setLines([...lines, { kind, description: '', dateIn: '', dateOut: '', qty: '', nightly: '', amount: '' }]);
  const removeLine = (i) => setLines(lines.filter((_, j) => j !== i));

  async function applyRateCard() {
    try {
      const { quote: q } = await api.quoteBooking(invoice.bookingId);
      if (!q) return;
      const nightly = q.nights ? Math.round((q.accommodationCents - q.discountCents) / q.nights) / 100 : 0;
      setLines((prev) => {
        const next = prev.map((l, i) => (i === 0 ? { ...l, kind: 'stay', qty: q.nights, nightly, amount: '' } : { ...l }));
        const setSvc = (kw, label, cents) => {
          if (cents <= 0) return;
          const idx = next.findIndex((l) => l.description.toLowerCase().includes(kw));
          if (idx >= 0) next[idx] = { ...next[idx], kind: 'charge', dateIn: '', dateOut: '', qty: '', nightly: '', amount: cents / 100 };
          else next.push({ kind: 'charge', description: label, dateIn: '', dateOut: '', qty: '', nightly: '', amount: cents / 100 });
        };
        setSvc('clean', 'Cleaning', q.cleaningCents);
        setSvc('early', 'Early check-in', q.earlyCents);
        setSvc('late', 'Late checkout', q.lateCents);
        setSvc('mattress', 'Extra mattress', q.mattressCents);
        setSvc('breakage', 'Refundable breakage deposit', q.breakageCents);
        return next;
      });
      setDiscountPercent(0);
      setDueNow(centsToRand(Math.max(0, Math.min(Math.round(q.totalCents / 2), q.totalCents - paidCents))));
      setMsg(`Applied rate card · ${q.nights} nights` + (q.discountPercent ? ` · ${q.discountPercent}% length discount` : ''));
    } catch (e) {
      setMsg(e.message === 'no_rate_card' ? 'No rate card for this property yet — set one via ☰ → property → $ Pricing.' : e.message);
    }
  }

  async function save() {
    setBusy(true); setMsg('');
    try {
      const r = await api.updateInvoice(invoice.id, {
        date, invoiceType,
        billToName: bill.name, billToAddress: bill.address, billToAttention: bill.attention,
        billToEmail: bill.email, billToPhone: bill.phone,
        lineItems: lines.map((l) => (l.kind === 'stay'
          ? { kind: 'stay', description: l.description, dateIn: l.dateIn, dateOut: l.dateOut,
              qty: Number(l.qty) || 0, nightlyCents: randToCents(l.nightly), amountCents: lineCents(l) }
          : { kind: 'charge', description: l.description, dateIn: '', dateOut: '',
              qty: 1, nightlyCents: 0, amountCents: lineCents(l) })),
        discountPercent: Number(discountPercent) || 0,
        totalCents, dueNowCents: randToCents(dueNow), paidCents,
        specialConditions: special,
      });
      setMsg('Saved.'); onSaved && onSaved(r.invoice);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function duplicate() {
    setBusy(true);
    try { const r = await api.duplicateInvoice(invoice.id); onDuplicated && onDuplicated(r.invoice); }
    catch (e) { setMsg(e.message); setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Delete invoice ${invoice.number}?`)) return;
    setBusy(true);
    try { await api.deleteInvoice(invoice.id); onDeleted && onDeleted(invoice.id); }
    catch (e) { setMsg(e.message); setBusy(false); }
  }

  return (
    <div className="invoice-wrap">
      <div className="invoice-actions no-print">
        <button className="secondary" onClick={onEditBiller}>Biller settings</button>
        {invoice.bookingId && <button className="secondary" onClick={applyRateCard}>Apply rate card</button>}
        <div className="spacer" />
        {msg && <span className="muted small">{msg}</span>}
        <button className="secondary" onClick={duplicate} disabled={busy}>Duplicate</button>
        <button className="danger ghost" onClick={remove} disabled={busy}>Delete</button>
        <button className="secondary" onClick={() => window.print()} disabled={busy}>Print / PDF</button>
        <button onClick={save} disabled={busy}>{busy ? '…' : 'Save'}</button>
      </div>

      <div className="invoice-doc">
        <div className="inv-top">
          <div className="inv-from">
            <div className="inv-company">{B.companyName || 'Your company'}</div>
            {B.registrationNo && <div className="inv-sub">Reg {B.registrationNo}</div>}
            {B.addressLines && <div className="inv-sub pre">{B.addressLines}</div>}
            {B.email && <div className="inv-sub">{B.email}</div>}
            {B.phone && <div className="inv-sub">{B.phone}</div>}
          </div>
          <div className="inv-meta">
            <div className="inv-title">INVOICE</div>
            <div className="inv-num">{invoice.number}</div>
            <label className="inv-field"><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="inv-field"><span>For</span><input value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)} /></label>
          </div>
        </div>

        <div className="inv-billto">
          <div className="inv-label">Invoice to</div>
          <input className="strong" placeholder="Client / company name" value={bill.name} onChange={(e) => setB('name', e.target.value)} />
          <textarea rows={3} placeholder="Address" value={bill.address} onChange={(e) => setB('address', e.target.value)} />
          <div className="inv-billrow">
            <input placeholder="Attention" value={bill.attention} onChange={(e) => setB('attention', e.target.value)} />
            <input placeholder="Email" value={bill.email} onChange={(e) => setB('email', e.target.value)} />
            <input placeholder="Tel" value={bill.phone} onChange={(e) => setB('phone', e.target.value)} />
          </div>
        </div>

        <table className="inv-table">
          <colgroup>
            <col /><col className="c-date" /><col className="c-date" /><col className="c-qty" />
            <col className="c-nightly" /><col className="c-amount" /><col className="c-del no-print" />
          </colgroup>
          <thead>
            <tr><th className="ld">Description</th><th>In</th><th>Out</th><th>Qty</th><th className="rt">Nightly</th><th className="rt">Amount</th><th className="no-print" /></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><textarea className="desc" rows={1} ref={autoGrow} value={l.description}
                  onChange={(e) => { setLine(i, 'description', e.target.value); autoGrow(e.target); }}
                  placeholder={l.kind === 'stay' ? 'Accommodation' : 'Deposit / once-off charge'} /></td>
                {l.kind === 'stay' ? (<>
                  <td><input className="date" type="date" value={l.dateIn} onChange={(e) => setLine(i, 'dateIn', e.target.value)} /></td>
                  <td><input className="date" type="date" value={l.dateOut} onChange={(e) => setLine(i, 'dateOut', e.target.value)} /></td>
                  <td><input className="xs" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} placeholder="—" title="Auto-calculated from In/Out" /></td>
                  <td className="rt"><input className="num" value={l.nightly} onChange={(e) => setLine(i, 'nightly', e.target.value)} placeholder="0.00" /></td>
                  <td className="rt">{Number(l.nightly) > 0 ? fmtR(lineCents(l)) : <MoneyInput value={l.amount} onChange={(v) => setLine(i, 'amount', v)} />}</td>
                </>) : (<>
                  <td colSpan={4} />
                  <td className="rt"><MoneyInput value={l.amount} onChange={(v) => setLine(i, 'amount', v)} /></td>
                </>)}
                <td className="no-print"><button className="del sm" onClick={() => removeLine(i)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="add-line no-print">
          <button className="mini" onClick={() => addLine('stay')}>+ Stay line</button>
          <button className="mini" onClick={() => addLine('charge')}>+ Deposit / once-off</button>
        </div>

        <div className="inv-totals">
          <div className="inv-trow"><span>Subtotal</span><b>{fmtR(subtotal)}</b></div>
          <div className="inv-trow">
            <span>Discount <input className="pct no-print" value={discountPercent} onChange={(e) => setDiscountPercent(e.target.value)} />% </span>
            <b>−{fmtR(discountCents)}</b>
          </div>
          <div className="inv-trow sub"><span>Invoice total</span><b>{fmtR(totalCents)}</b></div>
          <div className={'inv-trow paid' + (paidCents ? '' : ' no-print')}>
            <span>Less: amount paid</span>
            <b>−<MoneyInput value={paid} onChange={setPaid} /></b>
          </div>
          <div className="inv-trow total"><span>Outstanding amount</span><b>{fmtR(outstandingCents)}</b></div>
          <div className="inv-trow due">
            <span>Due now <button className="mini no-print" onClick={() => setDueNow(centsToRand(Math.max(0, Math.min(Math.round(totalCents / 2), outstandingCents))))}>50%</button>
              {paidCents > 0 && <button className="mini no-print" onClick={() => setDueNow(centsToRand(Math.max(0, outstandingCents)))}>Balance</button>}</span>
            <b><MoneyInput value={dueNow} onChange={setDueNow} /></b>
          </div>
        </div>

        <div className={'inv-conditions' + (special.trim() ? '' : ' no-print')}>
          <div className="inv-label">Special conditions</div>
          <textarea rows={2} value={special} onChange={(e) => setSpecial(e.target.value)} placeholder="Optional — add conditions for this invoice only" />
        </div>

        <div className="inv-pay">
          <div className="inv-label">{B.paymentInstruction || 'Payment details'}</div>
          <div className="inv-bank">
            {B.companyName && <div>{B.companyName}</div>}
            {B.bankName && <div>{B.bankName}</div>}
            {B.accountNumber && <div>Acct number: {B.accountNumber}</div>}
            {B.branch && <div>Branch: {B.branch}</div>}
            {B.swiftCode && <div>Swift: {B.swiftCode}</div>}
            {!B.bankName && <div className="muted small no-print">Add bank details in Biller settings.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
