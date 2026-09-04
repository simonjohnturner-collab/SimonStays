import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

function rel(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// A small "form alerts" bell: polls for recent damage/clean submissions and
// shows a count of unhandled ("new") ones so the host can act quickly.
export default function NotificationsBell({ onOpen }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  async function load() {
    try { const r = await api.listFormSubmissions('?limit=20'); setItems(r.submissions || []); } catch { /* offline */ }
  }
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const newCount = items.filter((s) => s.status === 'new').length;

  return (
    <div className="notif" ref={ref}>
      <button className="ghost notif-bell" title="Form alerts" onClick={() => { setOpen((o) => !o); load(); }}>
        🔔{newCount > 0 && <span className="notif-badge">{newCount}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-head">Form alerts{newCount > 0 ? <span className="muted small"> · {newCount} new</span> : ''}</div>
          {items.length === 0 && <div className="notif-empty">No submissions yet. Guests and cleaners can send them from the forms links.</div>}
          {items.map((s) => (
            <button key={s.id} className={`notif-item ${s.status === 'new' ? 'unseen' : ''}`} onClick={() => { setOpen(false); onOpen(s.id); }}>
              <span className="ni-line">
                <span className={`ftag ${s.type}`}>{s.type === 'damage' ? 'Issue' : 'Clean'}</span>
                <span className="ni-where">{s.propertyName ? `${s.propertyName}${s.unitName ? ' · ' + s.unitName : ''}` : 'No property'}</span>
              </span>
              <span className="ni-sub">{s.submitterName || '—'}{s.photoCount ? ` · 📷 ${s.photoCount}` : ''} · {rel(s.createdAt)}{s.status !== 'new' ? ` · ${s.status}` : ''}</span>
            </button>
          ))}
          {items.length > 0 && <button className="notif-all" onClick={() => { setOpen(false); onOpen(null); }}>View all in Forms →</button>}
        </div>
      )}
    </div>
  );
}
