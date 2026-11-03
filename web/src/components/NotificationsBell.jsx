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

// The board's alerts bell: polls for unread guest messages and recent
// damage/clean/repair submissions, shows a count of unhandled ones, and holds the
// sound controls. The actual chime + toast is played globally by <FormChime>.
export default function NotificationsBell({ onOpen, onOpenMessage, onCount }) {
  const [items, setItems] = useState([]);
  const [messages, setMessages] = useState([]); // conversations with unread guest messages
  const [loaded, setLoaded] = useState(false);
  const [ringing, setRinging] = useState(false);
  const seenRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem('ss_forms_mute') === '1'; } catch { return false; } });
  const ref = useRef(null);

  async function load() {
    try { const r = await api.listFormSubmissions('?limit=20'); setItems(r.submissions || []); } catch { /* offline */ }
    try { const r = await api.messageUnread(); setMessages(r.threads || []); } catch { /* offline */ }
    setLoaded(true);
  }
  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    window.addEventListener('ss:new-alert', load); // <FormChime> just spotted something new
    return () => { clearInterval(id); window.removeEventListener('ss:new-alert', load); };
    // eslint-disable-next-line
  }, []);

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
    setMuted((m) => { const v = !m; try { localStorage.setItem('ss_forms_mute', v ? '1' : '0'); } catch {} if (!v) window.dispatchEvent(new Event('ss:test-chime')); return v; });
  }
  function testSound() { window.dispatchEvent(new Event('ss:test-chime')); }

  async function dismiss(id) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, status: 'reviewed' } : x))); // optimistic
    try { await api.updateFormSubmission(id, { status: 'reviewed' }); } catch { load(); }
  }

  const newCount = items.filter((s) => s.status === 'new').length + messages.reduce((n, m) => n + m.unread, 0);

  // Ring when the count goes up, but not just for opening the board with alerts waiting.
  useEffect(() => {
    if (!loaded) return;
    if (seenRef.current !== null && newCount > seenRef.current) setRinging(true);
    seenRef.current = newCount;
  }, [loaded, newCount]);
  useEffect(() => {
    if (!ringing) return;
    const t = setTimeout(() => setRinging(false), 1600);
    return () => clearTimeout(t);
  }, [ringing]);

  return (
    <div className="notif" ref={ref}>
      <button className={`ghost notif-bell ${ringing ? 'ringing' : ''}`} title="Messages and form alerts" onClick={() => { setOpen((o) => !o); load(); }}>
        🔔{newCount > 0 && <span className="notif-badge">{newCount}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            Alerts{newCount > 0 ? <span className="muted small"> · {newCount} new</span> : ''}
            <button className="notif-mute" title="Play a test chime" onClick={testSound}>🔊 Test</button>
            <button className="notif-mute" title={muted ? 'Sounds off — click to turn on' : 'Sounds on — click to mute'} onClick={toggleMute}>{muted ? '🔕' : '🔔'}</button>
          </div>
          {items.length === 0 && messages.length === 0 && <div className="notif-empty">Nothing yet. New guest messages appear here, along with reports sent from the forms links.</div>}
          {messages.map((m) => (
            <div key={m.bookingId} className="notif-item unseen">
              <button className="ni-main" onClick={() => { setOpen(false); onOpenMessage(m.bookingId); }}>
                <span className="ni-line">
                  <span className="ftag message">{m.enquiry ? 'Enquiry' : 'Message'}</span>
                  <span className="ni-where">{m.guestName || 'Guest'}{m.propertyName ? ` · ${m.propertyName}${m.unitName ? ' · ' + m.unitName : ''}` : ''}</span>
                </span>
                <span className="ni-sub">{m.unread > 1 ? `${m.unread} new · ` : ''}{m.body} · {rel(m.createdAt)}</span>
              </button>
            </div>
          ))}
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
          <button className="notif-all" onClick={() => { setOpen(false); onOpenMessage(null); }}>View all messages →</button>
        </div>
      )}
    </div>
  );
}
