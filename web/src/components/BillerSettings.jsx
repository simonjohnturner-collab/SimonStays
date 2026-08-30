import { useState } from 'react';
import { api } from '../api.js';

// Edit the host's "invoice from" details + bank info (reused on every invoice).
export default function BillerSettings({ biller, onClose, onSaved }) {
  const [f, setF] = useState({
    companyName: biller?.companyName || '', registrationNo: biller?.registrationNo || '',
    addressLines: biller?.addressLines || '', email: biller?.email || '', phone: biller?.phone || '',
    bankName: biller?.bankName || '', accountNumber: biller?.accountNumber || '',
    branch: biller?.branch || '', swiftCode: biller?.swiftCode || '',
    paymentInstruction: biller?.paymentInstruction || '', specialConditions: biller?.specialConditions || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF({ ...f, [k]: v });

  async function save() {
    setBusy(true);
    try { const r = await api.saveBiller(f); onSaved(r.biller); }
    catch (e) { setBusy(false); alert(e.message); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>Biller settings (your details)</h3><button className="x" onClick={onClose}>×</button></div>
        <p className="muted small">These appear as the “from” on every invoice.</p>

        <label>Company name<input value={f.companyName} onChange={(e) => set('companyName', e.target.value)} /></label>
        <div className="row2">
          <label>Registration no<input value={f.registrationNo} onChange={(e) => set('registrationNo', e.target.value)} /></label>
          <label>Phone<input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        </div>
        <label>Email<input value={f.email} onChange={(e) => set('email', e.target.value)} /></label>
        <label>Address<textarea rows={2} value={f.addressLines} onChange={(e) => set('addressLines', e.target.value)} /></label>

        <fieldset>
          <legend>Bank details</legend>
          <div className="row2">
            <label>Bank<input value={f.bankName} onChange={(e) => set('bankName', e.target.value)} /></label>
            <label>Account number<input value={f.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} /></label>
          </div>
          <div className="row2">
            <label>Branch<input value={f.branch} onChange={(e) => set('branch', e.target.value)} /></label>
            <label>Swift<input value={f.swiftCode} onChange={(e) => set('swiftCode', e.target.value)} /></label>
          </div>
          <label>Payment instruction<input value={f.paymentInstruction} onChange={(e) => set('paymentInstruction', e.target.value)} placeholder="Pls Pay …" /></label>
        </fieldset>

        <label>Default special conditions<textarea rows={2} value={f.specialConditions} onChange={(e) => set('specialConditions', e.target.value)} /></label>

        <div className="modal-actions">
          <div className="spacer" />
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={busy}>{busy ? '…' : 'Save details'}</button>
        </div>
      </div>
    </div>
  );
}
