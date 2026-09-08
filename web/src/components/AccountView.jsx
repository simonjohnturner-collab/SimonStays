import { useEffect, useState } from 'react';
import { api, photoUrl } from '../api.js';

// Downscale a picked image to a small square-ish JPEG for the profile photo.
function toDataUrl(file, maxDim = 600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        URL.revokeObjectURL(url);
        let { width: w, height: h } = img;
        if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        const out = c.toDataURL('image/jpeg', quality);
        if (!out || out.length < 100) return readRaw(file).then(resolve, reject);
        resolve(out);
      } catch { readRaw(file).then(resolve, reject); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); readRaw(file).then(resolve, reject); };
    img.src = url;
  });
}
function readRaw(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }

// Host account: payout details (where SimonStays pays this host out) and login
// credential management. Everything is scoped to the logged-in host.
export default function AccountView({ onClose, onEmailChanged }) {
  const [acct, setAcct] = useState(null);
  const [msg, setMsg] = useState('');
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1800); };

  useEffect(() => { api.getAccount().then((r) => setAcct(r.account)).catch((e) => setMsg(e.message)); }, []);
  const set = (k, v) => setAcct((a) => ({ ...a, [k]: v }));

  const [photoBusy, setPhotoBusy] = useState(false);
  async function onPickPhoto(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    setPhotoBusy(true); setMsg('');
    try { const dataBase64 = await toDataUrl(file); const r = await api.uploadAccountPhoto(dataBase64, 'image/jpeg'); setAcct((a) => ({ ...a, photoId: r.photoId })); flash('Photo updated.'); }
    catch (err) { setMsg(err.message || 'Photo upload failed.'); } finally { setPhotoBusy(false); }
  }
  async function removePhoto() {
    if (!window.confirm('Remove your profile photo?')) return;
    setPhotoBusy(true);
    try { await api.deleteAccountPhoto(); setAcct((a) => ({ ...a, photoId: null })); flash('Photo removed.'); }
    catch (err) { setMsg(err.message); } finally { setPhotoBusy(false); }
  }

  const [savingP, setSavingP] = useState(false);
  async function savePayout() {
    setSavingP(true); setMsg('');
    try {
      const r = await api.saveAccount({
        name: acct.name || '', contactPhone: acct.contactPhone || '',
        payoutMethod: acct.payoutMethod || '', payoutBankName: acct.payoutBankName || '',
        payoutAccountName: acct.payoutAccountName || '', payoutAccountNumber: acct.payoutAccountNumber || '',
        payoutBranchCode: acct.payoutBranchCode || '', payoutNotes: acct.payoutNotes || '',
      });
      setAcct(r.account); flash('Payout details saved.');
    } catch (e) { setMsg(e.message); } finally { setSavingP(false); }
  }

  // credentials
  const [emailPw, setEmailPw] = useState(''); const [newEmail, setNewEmail] = useState(''); const [emailBusy, setEmailBusy] = useState(false);
  async function saveEmail() {
    if (!emailPw || !newEmail) { setMsg('Enter your password and a new email.'); return; }
    setEmailBusy(true); setMsg('');
    try { const r = await api.changeEmail(emailPw, newEmail); setAcct(r.account); setEmailPw(''); setNewEmail(''); flash('Email updated.'); onEmailChanged && onEmailChanged(r.account); }
    catch (e) { setMsg(e.message); } finally { setEmailBusy(false); }
  }

  const [curPw, setCurPw] = useState(''); const [newPw, setNewPw] = useState(''); const [newPw2, setNewPw2] = useState(''); const [pwBusy, setPwBusy] = useState(false);
  async function savePassword() {
    if (!curPw || !newPw) { setMsg('Enter your current and new password.'); return; }
    if (newPw !== newPw2) { setMsg('New passwords do not match.'); return; }
    setPwBusy(true); setMsg('');
    try { await api.changePassword(curPw, newPw); setCurPw(''); setNewPw(''); setNewPw2(''); flash('Password changed.'); }
    catch (e) { setMsg(e.message); } finally { setPwBusy(false); }
  }

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Account</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="account-wrap">
        {!acct ? <p className="muted small">Loading…</p> : (
          <>
            <section className="acct-card">
              <h3>👤 Your profile</h3>
              <p className="muted small">Your name and photo appear as “Hosted by …” on the public booking site.</p>
              <div className="acct-photo-row">
                <div className="acct-avatar">{acct.photoId ? <img src={photoUrl(acct.photoId)} alt="profile" /> : <span>🙂</span>}</div>
                <div className="acct-photo-actions">
                  <label className="btn-like">{photoBusy ? 'Uploading…' : (acct.photoId ? 'Change photo' : 'Upload photo')}
                    <input type="file" accept="image/*" disabled={photoBusy} onChange={onPickPhoto} hidden /></label>
                  {acct.photoId && <button className="secondary" disabled={photoBusy} onClick={removePhoto}>Remove</button>}
                </div>
              </div>
            </section>

            <section className="acct-card">
              <h3>💳 Payout details</h3>
              <p className="muted small">SimonStays collects guest bookings &amp; payments, then pays you out to the account below. Keep this accurate so payouts reach you.</p>
              <label>Your name / trading name<input value={acct.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Catwalk Property Services" /></label>
              <label>Contact number<input value={acct.contactPhone || ''} onChange={(e) => set('contactPhone', e.target.value)} placeholder="e.g. +27 82 123 4567" /></label>
              <div className="two">
                <label>Payout method<input value={acct.payoutMethod || ''} onChange={(e) => set('payoutMethod', e.target.value)} placeholder="Bank transfer (EFT)" /></label>
                <label>Bank<input value={acct.payoutBankName || ''} onChange={(e) => set('payoutBankName', e.target.value)} placeholder="e.g. FNB" /></label>
              </div>
              <label>Account holder<input value={acct.payoutAccountName || ''} onChange={(e) => set('payoutAccountName', e.target.value)} placeholder="Name on the account" /></label>
              <div className="two">
                <label>Account number<input value={acct.payoutAccountNumber || ''} onChange={(e) => set('payoutAccountNumber', e.target.value)} placeholder="Account number" /></label>
                <label>Branch code<input value={acct.payoutBranchCode || ''} onChange={(e) => set('payoutBranchCode', e.target.value)} placeholder="Branch / routing code" /></label>
              </div>
              <label>Notes for payouts <span className="muted small">(optional)</span><input value={acct.payoutNotes || ''} onChange={(e) => set('payoutNotes', e.target.value)} placeholder="e.g. reference to use, split arrangements" /></label>
              <button disabled={savingP} onClick={savePayout}>{savingP ? 'Saving…' : '💾 Save payout details'}</button>
            </section>

            <section className="acct-card">
              <h3>✉️ Email</h3>
              <p className="muted small">You sign in with <b>{acct.email}</b>.</p>
              <label>Current password<input type="password" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} placeholder="Confirm it's you" /></label>
              <label>New email<input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="new@email.com" /></label>
              <button className="secondary" disabled={emailBusy} onClick={saveEmail}>{emailBusy ? 'Updating…' : 'Update email'}</button>
            </section>

            <section className="acct-card">
              <h3>🔑 Password</h3>
              <label>Current password<input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} /></label>
              <div className="two">
                <label>New password<input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="At least 8 characters" /></label>
                <label>Confirm new password<input type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} /></label>
              </div>
              <button className="secondary" disabled={pwBusy} onClick={savePassword}>{pwBusy ? 'Changing…' : 'Change password'}</button>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
