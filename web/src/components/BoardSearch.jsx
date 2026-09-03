import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Jump-to-reservation search: type a guest name or Airbnb confirmation code and
// pick a result to reposition the board on that booking.
export default function BoardSearch({ onJump }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      setBusy(true);
      try { const r = await api.searchBookings(term); setResults(r.results); setOpen(true); }
      catch { setResults([]); }
      finally { setBusy(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(r) { setOpen(false); setQ(''); setResults([]); onJump(r); }
  const fmt = (iso) => (iso || '').slice(0, 10);

  return (
    <div className="board-search" ref={boxRef}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        placeholder="🔎 Jump to reservation — guest or Airbnb code"
        aria-label="Jump to a reservation by guest name or Airbnb confirmation code"
      />
      {open && (
        <div className="board-search-results">
          {busy && <div className="bsr-empty">Searching…</div>}
          {!busy && results.length === 0 && q.trim().length >= 2 && <div className="bsr-empty">No matches for “{q.trim()}”.</div>}
          {results.map((r) => (
            <button key={r.id} className="bsr-item" onClick={() => pick(r)}>
              <span className="bsr-name">
                {r.guestName || '(guest)'}
                {r.resCode ? <span className="bsr-code"> · {r.resCode}</span> : null}
              </span>
              <span className="bsr-sub">
                {r.propertyName ? `${r.propertyName} · ${r.unitName}` : 'Floating'} · {fmt(r.checkIn)} → {fmt(r.checkOut)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
