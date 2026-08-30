import { useState } from 'react';
import { api } from '../api.js';
import { fmtR, randToCents, centsToRand } from '../money.js';

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
  const [lines, setLines] = useState((invoice.lineItems || []).map((l) => ({
    description: l.description || '', dateIn: l.dateIn || '', dateOut: l.dateOut || '',
    qty: l.qty ?? '', nightly: centsToRand(l.nightlyCents), amount: centsToRand(l.amountCents),
  })));
  const [discountPercent, setDiscountPercent] = useState(invoice.discountPercent || 0);
  const [dueNow, setDueNow] = useState(centsToRand(invoice.dueNowCents));
  const [special, setSpecial] = useState(invoice.specialConditions || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const lineCents = (l) => (Number(l.nightly) > 0 ? Math.round((Number(l.qty) || 0) * Number(l.nightly) * 100) : randToCents(l.amount));
  const subtotal = lines.reduce((s, l) => s + lineCents(l), 0);
  const discountCents = Math.round(subtotal * (Number(discountPercent) || 0) / 100);
  const totalCents = subtotal - discountCents;

  const setB = (k, v) => setBill({ ...bill, [k]: v });
  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const addLine = () => setLines([...lines, { description: '', dateIn: '', dateOut: '', qty: '', nightly: '', amount: '' }]);
  const removeLine = (i) => setLines(lines.filter((_, j) => j !== i));

  async function save() {
    setBusy(true); setMsg('');
    try {
      const r = await api.updateInvoice(invoice.id, {
        date, invoiceType,
        billToName: bill.name, billToAddress: bill.address, billToAttention: bill.attention,
        billToEmail: bill.email, billToPhone: bill.phone,
        lineItems: lines.map((l) => ({
          description: l.description, dateIn: l.dateIn, dateOut: l.dateOut,
          qty: Number(l.qty) || 0, nightlyCents: randToCents(l.nightly), amountCents: lineCents(l),
        })),
        discountPercent: Number(discountPercent) || 0,
        totalCents, dueNowCents: randToCents(dueNow),
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
          <thead>
            <tr><th className="ld">Description</th><th>In</th><th>Out</th><th>Qty</th><th className="rt">Nightly</th><th className="rt">Amount</th><th className="no-print" /></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><input value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} placeholder="Item" /></td>
                <td><input className="sm" value={l.dateIn} onChange={(e) => setLine(i, 'dateIn', e.target.value)} placeholder="—" /></td>
                <td><input className="sm" value={l.dateOut} onChange={(e) => setLine(i, 'dateOut', e.target.value)} placeholder="—" /></td>
                <td><input className="xs" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} placeholder="—" /></td>
                <td className="rt"><input className="num" value={l.nightly} onChange={(e) => setLine(i, 'nightly', e.target.value)} placeholder="0.00" /></td>
                <td className="rt">{Number(l.nightly) > 0 ? fmtR(lineCents(l)) : <input className="num" value={l.amount} onChange={(e) => setLine(i, 'amount', e.target.value)} placeholder="0.00" />}</td>
                <td className="no-print"><button className="del sm" onClick={() => removeLine(i)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="mini no-print add-line" onClick={addLine}>+ Add line</button>

        <div className="inv-totals">
          <div className="inv-trow"><span>Subtotal</span><b>{fmtR(subtotal)}</b></div>
          <div className="inv-trow">
            <span>Discount <input className="pct no-print" value={discountPercent} onChange={(e) => setDiscountPercent(e.target.value)} />% </span>
            <b>−{fmtR(discountCents)}</b>
          </div>
          <div className="inv-trow total"><span>Outstanding amount</span><b>{fmtR(totalCents)}</b></div>
          <div className="inv-trow due">
            <span>Due now <button className="mini no-print" onClick={() => setDueNow(centsToRand(Math.round(totalCents / 2)))}>50%</button></span>
            <b><input className="num" value={dueNow} onChange={(e) => setDueNow(e.target.value)} placeholder="0.00" /></b>
          </div>
        </div>

        <div className="inv-conditions">
          <div className="inv-label">Special conditions</div>
          <textarea rows={2} value={special} onChange={(e) => setSpecial(e.target.value)} placeholder="e.g. 50% deposit to confirm, 50% on arrival · Weekly clean included" />
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
