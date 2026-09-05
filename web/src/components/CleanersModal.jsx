import { useState } from 'react';
import { api } from '../api.js';

// Manage the host's cleaner names (used by the cleaner dropdowns).
export default function CleanersModal({ cleaners = [], onClose, onSaved }) {
  const [list, setList] = useState(cleaners);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const add = () => { const n = name.trim(); if (n && !list.includes(n)) setList([...list, n]); setName(''); };
  const remove = (n) => setList(list.filter((x) => x !== n));

  async function save() {
    setBusy(true);
    try { const r = await api.saveCleaners(list); onSaved(r.cleaners); onClose(); }
    catch { setBusy(false); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>Cleaners</h3><button className="x" onClick={onClose}>×</button></div>
        <p className="muted small">These names appear as a dropdown when assigning a checkout cleaner and on the cleaner’s checkout form.</p>
        <div className="cleaner-list">
          {list.length === 0 && <p className="muted small">No cleaners yet — add one below.</p>}
          {list.map((n) => (
            <div key={n} className="cleaner-row"><span>{n}</span><button className="del" title="Remove" onClick={() => remove(n)}>×</button></div>
          ))}
        </div>
        <div className="add-chan" style={{ marginTop: 10 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a cleaner name"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
          <button onClick={add}>Add</button>
        </div>
        <div className="modal-actions">
          <div className="spacer" />
          <button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
