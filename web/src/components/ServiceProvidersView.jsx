import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Directory of service providers: cleaners, electricians, plumbers, handymen…
// Cleaners here feed the checkout-cleaner dropdowns. Units are the properties'
// units this provider works in.
const ROLES = ['Cleaner', 'Electrician', 'Plumber', 'Handyman', 'Gardener', 'Pool service', 'Security', 'Other'];

export default function ServiceProvidersView({ onClose, properties = [], onChanged }) {
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  const [nw, setNw] = useState({ name: '', role: 'Cleaner', phone: '' });
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1500); };

  async function load() { try { const r = await api.listProviders(); setRows(r.providers); } catch (e) { setMsg(e.message); } }
  useEffect(() => { load(); }, []);

  const editLocal = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  async function addProvider() {
    if (!nw.name.trim()) { setMsg('Enter a name.'); return; }
    try { await api.createProvider({ ...nw, name: nw.name.trim() }); setNw({ name: '', role: nw.role, phone: '' }); await load(); onChanged && onChanged(); flash('Added.'); }
    catch (e) { setMsg(e.message); }
  }
  async function saveRow(r) {
    try { await api.updateProvider(r.id, { name: r.name, role: r.role, phone: r.phone, notes: r.notes, propertyIds: r.propertyIds }); onChanged && onChanged(); flash('Saved.'); }
    catch (e) { setMsg(e.message); }
  }
  async function removeRow(r) {
    if (!window.confirm(`Remove ${r.name}?`)) return;
    try { await api.deleteProvider(r.id); await load(); onChanged && onChanged(); }
    catch (e) { setMsg(e.message); }
  }
  function toggleProperty(r, pid) {
    const has = (r.propertyIds || []).includes(pid);
    const propertyIds = has ? r.propertyIds.filter((x) => x !== pid) : [...(r.propertyIds || []), pid];
    editLocal(r.id, { propertyIds });
    api.updateProvider(r.id, { name: r.name, role: r.role, phone: r.phone, notes: r.notes, propertyIds }).then(() => onChanged && onChanged()).catch((e) => setMsg(e.message));
  }

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Service providers</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="sp-wrap">
        <p className="muted small">Your cleaners, electricians, plumbers, handymen and other providers. <b>Cleaner</b> names appear in the checkout-cleaner dropdowns.</p>

        <div className="sp-add">
          <input placeholder="Name" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addProvider(); }} />
          <select value={nw.role} onChange={(e) => setNw({ ...nw, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
          <input placeholder="Contact number" value={nw.phone} onChange={(e) => setNw({ ...nw, phone: e.target.value })} />
          <button onClick={addProvider}>➕ Add</button>
        </div>

        {!rows ? <p className="muted small">Loading…</p> : rows.length === 0 ? (
          <p className="muted small">No providers yet — add your first one above.</p>
        ) : rows.map((r) => (
          <section key={r.id} className="sp-card">
            <div className="sp-top">
              <input className="sp-name" value={r.name} onChange={(e) => editLocal(r.id, { name: e.target.value })} onBlur={() => saveRow(r)} />
              <select className="sp-role" value={ROLES.includes(r.role) ? r.role : 'Other'} onChange={(e) => { editLocal(r.id, { role: e.target.value }); setTimeout(() => saveRow({ ...r, role: e.target.value }), 0); }}>
                {ROLES.map((x) => <option key={x}>{x}</option>)}
              </select>
              <input className="sp-phone" placeholder="Contact number" value={r.phone || ''} onChange={(e) => editLocal(r.id, { phone: e.target.value })} onBlur={() => saveRow(r)} />
              <button className="del" title="Remove" onClick={() => removeRow(r)}>🗑</button>
            </div>
            <input className="sp-notes" placeholder="Notes (rates, availability, speciality…)" value={r.notes || ''} onChange={(e) => editLocal(r.id, { notes: e.target.value })} onBlur={() => saveRow(r)} />
            {properties.length > 0 && (
              <div className="sp-units">
                <span className="sp-units-label">Works at:</span>
                {properties.map((p) => (
                  <button key={p.id} type="button" className={`sp-unit ${(r.propertyIds || []).includes(p.id) ? 'on' : ''}`} onClick={() => toggleProperty(r, p.id)}>{p.name}</button>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
