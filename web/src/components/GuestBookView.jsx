import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Guest contact book: a track record of guests — name, phone, email, address,
// notes and previous damages. Names can be pulled in from bookings; contact
// details are added by hand (or from invoices / direct bookings).
export default function GuestBookView({ onClose }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [nw, setNw] = useState({ name: '', phone: '', email: '' });
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1600); };

  async function load() { try { const r = await api.listGuests(q); setRows(r.guests); } catch (e) { setMsg(e.message); } }
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [q]);

  const editLocal = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  async function addGuest() {
    if (!nw.name.trim()) { setMsg('Enter a name.'); return; }
    try { await api.createGuest({ ...nw, name: nw.name.trim() }); setNw({ name: '', phone: '', email: '' }); await load(); flash('Added.'); }
    catch (e) { setMsg(e.message); }
  }
  async function saveRow(r) {
    try { await api.updateGuest(r.id, { name: r.name, phone: r.phone, email: r.email, address: r.address, notes: r.notes, damages: r.damages }); flash('Saved.'); }
    catch (e) { setMsg(e.message); }
  }
  async function removeRow(r) {
    if (!window.confirm(`Remove ${r.name} from the contact book?`)) return;
    try { await api.deleteGuest(r.id); await load(); } catch (e) { setMsg(e.message); }
  }
  async function importFromBookings() {
    setBusy(true); setMsg('');
    try { const r = await api.importGuestsFromBookings(); await load(); flash(r.added ? `Imported ${r.added} guest name${r.added > 1 ? 's' : ''} from bookings.` : 'No new names to import.'); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Guest contact book</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" disabled={busy} onClick={importFromBookings}>{busy ? 'Importing…' : '⤵ Import from bookings'}</button>
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="gb-wrap">
        <div className="gb-tools">
          <input type="search" placeholder="Search name, phone or email…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        <div className="gb-add">
          <input placeholder="Guest name" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addGuest(); }} />
          <input placeholder="Phone" value={nw.phone} onChange={(e) => setNw({ ...nw, phone: e.target.value })} />
          <input placeholder="Email" value={nw.email} onChange={(e) => setNw({ ...nw, email: e.target.value })} />
          <button onClick={addGuest}>➕ Add guest</button>
        </div>

        {!rows ? <p className="muted small">Loading…</p> : rows.length === 0 ? (
          <p className="muted small">{q ? 'No guests match your search.' : 'No guests yet — add one above, or ⤵ Import from bookings to pull in guest names.'}</p>
        ) : (
          <>
            <p className="muted small">{rows.length} guest{rows.length === 1 ? '' : 's'}</p>
            {rows.map((r) => (
              <section key={r.id} className="gb-card">
                <div className="gb-top">
                  <input className="gb-name" value={r.name} onChange={(e) => editLocal(r.id, { name: e.target.value })} onBlur={() => saveRow(r)} />
                  <input className="gb-phone" placeholder="Phone" value={r.phone || ''} onChange={(e) => editLocal(r.id, { phone: e.target.value })} onBlur={() => saveRow(r)} />
                  <input className="gb-email" placeholder="Email" value={r.email || ''} onChange={(e) => editLocal(r.id, { email: e.target.value })} onBlur={() => saveRow(r)} />
                  <button className="del" title="Remove" onClick={() => removeRow(r)}>🗑</button>
                </div>
                <input className="gb-addr" placeholder="Business / postal address" value={r.address || ''} onChange={(e) => editLocal(r.id, { address: e.target.value })} onBlur={() => saveRow(r)} />
                <div className="gb-two">
                  <textarea placeholder="Notes" value={r.notes || ''} onChange={(e) => editLocal(r.id, { notes: e.target.value })} onBlur={() => saveRow(r)} />
                  <textarea className="gb-damages" placeholder="Previous damages (track record)" value={r.damages || ''} onChange={(e) => editLocal(r.id, { damages: e.target.value })} onBlur={() => saveRow(r)} />
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
