import { useEffect, useState } from 'react';
import { api } from '../api.js';

const CHANNELS = [
  { value: 'airbnb', label: 'Airbnb' },
  { value: 'booking', label: 'Booking.com' },
  { value: 'lekkeslaap', label: 'LekkeSlaap' },
  { value: 'other', label: 'Other (iCal)' },
];

export default function UnitPanel({ unit, onClose, onChanged, onNewBooking }) {
  const [feedUrl, setFeedUrl] = useState('');
  const [channels, setChannels] = useState([]);
  const [type, setType] = useState('airbnb');
  const [importUrl, setImportUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    const [u, ch] = await Promise.all([api.getUnit(unit.id), api.listChannels(unit.id)]);
    setFeedUrl(u.unit.feedUrl);
    setChannels(ch.channels);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [unit.id]);

  async function addChannel() {
    if (!importUrl.trim()) { setMsg('Paste the channel’s iCal URL first.'); return; }
    setBusy(true); setMsg('');
    try {
      await api.addChannel(unit.id, type, importUrl.trim());
      setImportUrl('');
      await load();
      setMsg('Channel added. Run Sync to pull its calendar in.');
    } catch (e) {
      setMsg(e.message === 'channel_already_connected' ? 'That iCal URL is already connected to this unit.' : e.message);
    } finally { setBusy(false); }
  }
  async function removeChannel(id) {
    if (!window.confirm('Remove this channel connection?')) return;
    await api.deleteChannel(id); await load();
  }
  async function syncNow() {
    setBusy(true); setMsg('Syncing…');
    try {
      const r = await api.syncUnit(unit.id);
      const s = r.summary;
      setMsg(`Synced: +${s.added} new, ${s.updated} updated, −${s.removed} removed` + (s.failed ? `, ${s.failed} failed` : ''));
      await load(); onChanged && onChanged();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  function copyFeed() { navigator.clipboard?.writeText(feedUrl); setMsg('Feed URL copied.'); }

  return (
    <div className="overlay right" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Unit {unit.name}</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>

        <button className="wide" onClick={onNewBooking}>➕ New booking for this unit</button>

        <div className="direction-note">
          <b>Two directions, both needed:</b>
          <div>⬇ <b>Import</b> pulls a channel’s bookings <i>into</i> StaySync (below).</div>
          <div>⬆ <b>Export</b> blocks a channel — paste StaySync’s feed <i>into</i> that channel’s <b>Import Calendar</b> (bottom). Airbnb re-pulls it every few hours.</div>
        </div>

        <section>
          <h4>⬇ Import channels (pull bookings in)</h4>
          <p className="muted small">Paste each channel’s iCal <b>export</b> URL. “Sync now” pulls its reservations <b>into</b> StaySync — it does not change the channel.</p>
          {channels.length === 0 && <p className="muted small">No channels connected yet.</p>}
          {channels.map((c) => (
            <div key={c.id} className="chan-row">
              <span className="tag">{labelFor(c.type)}</span>
              <span className="chan-url" title={c.importUrl}>{c.importUrl}</span>
              <span className={`chan-status ${c.lastStatus?.startsWith('error') ? 'bad' : 'ok'}`}>{c.lastStatus || 'not synced'}</span>
              <button className="mini danger" onClick={() => removeChannel(c.id)}>remove</button>
            </div>
          ))}
          <div className="add-chan">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <input placeholder="https://…/calendar.ics" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
            <button disabled={busy} onClick={addChannel}>Add</button>
          </div>
          <button className="secondary wide" disabled={busy} onClick={syncNow}>↻ Sync now</button>
        </section>

        <section>
          <h4>⬆ Export feed (push blocks out to channels)</h4>
          <p className="muted small">Copy this URL and paste it into each channel’s <b>Import Calendar</b> (on Airbnb: Listing ▸ Availability ▸ Sync calendars ▸ Import Calendar). It blocks the dates of this unit’s confirmed StaySync bookings. This is the step that makes your bookings show as unavailable on Airbnb.</p>
          <div className="feed-box">
            <code>{feedUrl}</code>
            <button className="mini" onClick={copyFeed}>copy</button>
          </div>
        </section>

        {msg && <div className="msg muted">{msg}</div>}
      </div>
    </div>
  );
}

function labelFor(t) { return (CHANNELS.find((c) => c.value === t) || {}).label || t; }
