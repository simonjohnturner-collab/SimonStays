import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Simplified unit settings: just the two links.
//  1. iCal calendar link — the channel's calendar we pull bookings FROM (editable).
//  2. Lock link — the feed you paste into a channel to block these dates (copy).
export default function UnitPanel({ unit, onClose, onChanged }) {
  const [importUrl, setImportUrl] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    const [u, ch] = await Promise.all([api.getUnit(unit.id), api.listChannels(unit.id)]);
    setFeedUrl(u.unit.feedUrl);
    const c = (ch.channels || [])[0];
    setImportUrl(c?.importUrl || '');
    setStatus(c?.lastStatus || '');
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [unit.id]);

  async function saveCalendar() {
    setBusy(true); setMsg('');
    try {
      await api.setCalendar(unit.id, importUrl.trim());
      if (importUrl.trim()) { await api.syncUnit(unit.id); setMsg('Saved & synced.'); }
      else setMsg('Calendar link cleared.');
      await load(); onChanged && onChanged();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  function copyLock() { navigator.clipboard?.writeText(feedUrl); setMsg('Lock link copied.'); }

  return (
    <div className="overlay right" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Unit {unit.name}</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>

        <label className="lk-label">iCal calendar link
          <span className="muted small"> — the channel calendar we pull bookings from</span>
        </label>
        <input value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="https://…/calendar.ics" />
        <div className="lk-actions">
          {status && <span className="muted small">{status}</span>}
          <div className="spacer" />
          <button disabled={busy} onClick={saveCalendar}>{busy ? '…' : 'Save'}</button>
        </div>

        <label className="lk-label" style={{ marginTop: 18 }}>Lock link
          <span className="muted small"> — paste into a channel’s “Import calendar” to block these dates</span>
        </label>
        <input value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} />
        <div className="lk-actions">
          <div className="spacer" />
          <button className="secondary" onClick={copyLock}>Copy</button>
        </div>

        {msg && <div className="msg muted" style={{ marginTop: 12 }}>{msg}</div>}
      </div>
    </div>
  );
}
