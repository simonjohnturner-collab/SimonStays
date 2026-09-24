import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const typeLabel = (t) => (t === 'damage' ? 'issue' : t === 'repair' ? 'repair' : 'clean');
const isMuted = () => { try { return localStorage.getItem('ss_forms_mute') === '1'; } catch { return false; } };

// Always mounted (in every admin view via withChrome): polls for new form
// submissions and, the instant one lands, plays a chime + pops a toast — no matter
// which screen the host is on. The board's bell shows the list/badge separately.
export default function FormChime({ onOpen }) {
  const [toast, setToast] = useState(null);
  const audioRef = useRef(null);
  const knownRef = useRef(new Set());
  const initRef = useRef(false);

  function ensureAudio() {
    try {
      if (!audioRef.current) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioRef.current = new AC(); }
      return audioRef.current || null;
    } catch { return null; }
  }
  function playTones(ctx) {
    const now = ctx.currentTime;
    [[880, 0], [1174.66, 0.13], [1567.98, 0.26]].forEach(([f, t]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.25, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.36);
      o.connect(g); g.connect(ctx.destination);
      o.start(now + t); o.stop(now + t + 0.42);
    });
  }
  function chime(force) {
    if (!force && isMuted()) return;
    const ctx = ensureAudio(); if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().then(() => playTones(ctx)).catch(() => {});
    else playTones(ctx);
  }

  // Unlock/resume audio on the first interaction (browsers require a gesture) and
  // whenever the tab regains focus; also answer a "test chime" event from the bell.
  useEffect(() => {
    const unlock = () => { const c = ensureAudio(); if (c && c.state === 'suspended') c.resume().catch(() => {}); };
    ['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, unlock));
    const onVis = () => { if (document.visibilityState === 'visible') { unlock(); load(); } };
    document.addEventListener('visibilitychange', onVis);
    const onTest = () => chime(true);
    window.addEventListener('ss:test-chime', onTest);
    return () => {
      ['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.removeEventListener(e, unlock));
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('ss:test-chime', onTest);
    };
    // eslint-disable-next-line
  }, []);

  function detect(list) {
    const known = knownRef.current;
    if (!initRef.current) { list.forEach((s) => known.add(s.id)); initRef.current = true; return; }
    const fresh = list.filter((s) => s.status === 'new' && !known.has(s.id));
    list.forEach((s) => known.add(s.id));
    if (fresh.length) {
      chime();
      const s = fresh[0];
      setToast({
        id: fresh.length === 1 ? s.id : null, n: fresh.length, type: s.type,
        where: s.propertyName ? `${s.propertyName}${s.unitName ? ' · ' + s.unitName : ''}` : 'a property',
        name: s.submitterName || '',
      });
    }
  }
  async function load() { try { const r = await api.listFormSubmissions('?limit=20'); detect(r.submissions || []); } catch { /* offline */ } }
  useEffect(() => { load(); const id = setInterval(load, 25000); return () => clearInterval(id); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 9000); return () => clearTimeout(t); }, [toast]);

  if (!toast) return null;
  return (
    <div className="form-chime-toast" onClick={() => { onOpen(toast.id || null); setToast(null); }}>
      <span className="fct-emoji">🔔</span>
      <span className="fct-body">
        <b>{toast.n > 1 ? `${toast.n} new reports` : `New ${typeLabel(toast.type)} report`}</b>
        <span className="fct-sub">{toast.where}{toast.name ? ` · ${toast.name}` : ''} — tap to open</span>
      </span>
      <button className="fct-x" title="Dismiss" onClick={(e) => { e.stopPropagation(); setToast(null); }}>×</button>
    </div>
  );
}
