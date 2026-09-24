import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

function rel(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const typeLabel = (t) => (t === 'damage' ? 'Issue' : t === 'repair' ? 'Repair' : 'Clean');

// A small "form alerts" bell: polls for recent damage/clean/repair submissions,
// shows a count of unhandled ("new") ones, and CHIMES + pops a toast the moment a
// brand-new report lands while the host has the board open.
export default function NotificationsBell({ onOpen, onCount }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem('ss_forms_mute') === '1'; } catch { return false; } });
  const ref = useRef(null);
  const audioRef = useRef(null);
  const knownRef = useRef(new Set()); // submission ids we've already seen
  const initRef = useRef(false);      // first poll = baseline (don't chime for the backlog)
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Lazily create/resume the audio context (browsers need a user gesture first).
  function ensureAudio() {
    try {
      if (!audioRef.current) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioRef.current = new AC(); }
      const ctx = audioRef.current;
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    } catch { return null; }
  }
  useEffect(() => {
    const unlock = () => ensureAudio();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);

  // A short, pleasant three-note rising chime (synthesised — no audio file needed).
  function chime() {
    if (mutedRef.current) return;
    const ctx = ensureAudio(); if (!ctx) return;
    const now = ctx.currentTime;
    [[880, 0], [1174.66, 0.13], [1567.98, 0.26]].forEach(([f, t]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.22, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.34);
      o.connect(g); g.connect(ctx.destination);
      o.start(now + t); o.stop(now + t + 0.4);
    });
  }

  function detectNew(list) {
    const known = knownRef.current;
    if (!initRef.current) { list.forEach((s) => known.add(s.id)); initRef.current = true; return; }
    const fresh = list.filter((s) => s.status === 'new' && !known.has(s.id));
    list.forEach((s) => known.add(s.id));
    if (fresh.length) {
      chime();
      const s = fresh[0];
      setToast({
        id: fresh.length === 1 ? s.id : null,
        n: fresh.length,
        type: s.type,
        where: s.propertyName ? `${s.propertyName}${s.unitName ? ' · ' + s.unitName : ''}` : 'a property',
        name: s.submitterName || '',
      });
    }
  }

  async function load() {
    try { const r = await api.listFormSubmissions('?limit=20'); const list = r.submissions || []; detectNew(list); setItems(list); } catch { /* offline */ }
  }
  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); /* eslint-disable-next-line */ }, []);

  // Auto-hide the toast after a few seconds.
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 9000); return () => clearTimeout(t); }, [toast]);

  // Report the unreviewed count + latest to the parent (for the board banner).
  useEffect(() => {
    if (!onCount) return;
    const news = items.filter((s) => s.status === 'new');
    onCount(news.length, news[0] || null);
    // eslint-disable-next-line
  }, [items]);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function toggleMute() {
    setMuted((m) => { const v = !m; try { localStorage.setItem('ss_forms_mute', v ? '1' : '0'); } catch {} if (!v) { const c = ensureAudio(); if (c) chime(); } return v; });
  }

  async function dismiss(id) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, status: 'reviewed' } : x))); // optimistic
    try { await api.updateFormSubmission(id, { status: 'reviewed' }); } catch { load(); }
  }

  const newCount = items.filter((s) => s.status === 'new').length;

  return (
    <div className="notif" ref={ref}>
      <button className={`ghost notif-bell ${toast ? 'ringing' : ''}`} title="Form alerts" onClick={() => { setOpen((o) => !o); load(); }}>
        🔔{newCount > 0 && <span className="notif-badge">{newCount}</span>}
      </button>

      {toast && (
        <div className="notif-toast" onClick={() => { if (toast.id) { onOpen(toast.id); } else { onOpen(null); } setToast(null); }}>
          <span className="nt-emoji">🔔</span>
          <span className="nt-body">
            <b>{toast.n > 1 ? `${toast.n} new reports` : `New ${typeLabel(toast.type).toLowerCase()} report`}</b>
            <span className="nt-sub">{toast.where}{toast.name ? ` · ${toast.name}` : ''} — tap to open</span>
          </span>
          <button className="nt-x" title="Dismiss" onClick={(e) => { e.stopPropagation(); setToast(null); }}>×</button>
        </div>
      )}

      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            Form alerts{newCount > 0 ? <span className="muted small"> · {newCount} new</span> : ''}
            <button className="notif-mute" title={muted ? 'Sounds off — click to turn on' : 'Sounds on — click to mute'} onClick={toggleMute}>{muted ? '🔕' : '🔔'}</button>
          </div>
          {items.length === 0 && <div className="notif-empty">No submissions yet. Guests, cleaners and contractors can send them from the forms links.</div>}
          {items.map((s) => (
            <div key={s.id} className={`notif-item ${s.status === 'new' ? 'unseen' : ''}`}>
              <button className="ni-main" onClick={() => { setOpen(false); onOpen(s.id); }}>
                <span className="ni-line">
                  <span className={`ftag ${s.type}`}>{typeLabel(s.type)}</span>
                  <span className="ni-where">{s.propertyName ? `${s.propertyName}${s.unitName ? ' · ' + s.unitName : ''}` : 'No property'}</span>
                </span>
                <span className="ni-sub">{s.submitterName || '—'}{s.photoCount ? ` · 📷 ${s.photoCount}` : ''} · {rel(s.createdAt)}{s.status !== 'new' ? ` · ${s.status}` : ''}</span>
              </button>
              {s.status === 'new' && <button className="ni-dismiss" title="Reviewed — clear this alert" onClick={() => dismiss(s.id)}>×</button>}
            </div>
          ))}
          {items.length > 0 && <button className="notif-all" onClick={() => { setOpen(false); onOpen(null); }}>View all in Forms →</button>}
        </div>
      )}
    </div>
  );
}
