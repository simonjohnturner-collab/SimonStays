import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { today, addDays, ymd } from '../dates.js';
import Board from './Board.jsx';
import BookingModal from './BookingModal.jsx';
import UnitPanel from './UnitPanel.jsx';

const WINDOW_DAYS = 35;

export default function Main() {
  const { host, logout } = useAuth();
  const [properties, setProperties] = useState([]);
  const [bookingsByUnit, setBookingsByUnit] = useState({});
  const [start, setStart] = useState(() => addDays(today(), -3));
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const [bookingCtx, setBookingCtx] = useState(null); // { unit } | { booking, unit }
  const [panelUnit, setPanelUnit] = useState(null);
  const [msg, setMsg] = useState('');

  const from = ymd(start);
  const to = ymd(addDays(start, WINDOW_DAYS));

  const loadBookings = useCallback(async (props) => {
    const units = props.flatMap((p) => p.units.map((u) => ({ ...u, propertyName: p.name })));
    const entries = await Promise.all(units.map(async (u) => {
      try { const r = await api.unitBookings(u.id, from, to); return [u.id, r.bookings]; }
      catch { return [u.id, []]; }
    }));
    setBookingsByUnit(Object.fromEntries(entries));
  }, [from, to]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listProperties();
      setProperties(r.properties);
      await loadBookings(r.properties);
    } finally { setLoading(false); }
  }, [loadBookings]);

  useEffect(() => { refresh(); }, [refresh]);

  async function addProperty() {
    const name = window.prompt('Property name (e.g. Firenza)');
    if (!name) return;
    await api.createProperty(name.trim());
    refresh();
  }
  async function addUnit(propertyId) {
    const name = window.prompt('Unit name / number (e.g. 23)');
    if (!name) return;
    await api.createUnit(propertyId, name.trim());
    refresh();
  }
  async function deleteProperty(p) {
    if (!window.confirm(`Delete property “${p.name}” and all its units/bookings?`)) return;
    await api.deleteProperty(p.id);
    refresh();
  }
  async function deleteUnit(u) {
    if (!window.confirm(`Delete unit “${u.name}” and its bookings?`)) return;
    await api.deleteUnit(u.id);
    refresh();
  }
  async function syncAll() {
    setSyncing(true); setMsg('');
    try {
      const units = properties.flatMap((p) => p.units);
      const results = await Promise.all(units.map((u) => api.syncUnit(u.id).catch(() => null)));
      const totals = results.reduce((a, r) => {
        if (r && r.summary) { a.added += r.summary.added; a.updated += r.summary.updated; a.removed += r.summary.removed; }
        return a;
      }, { added: 0, updated: 0, removed: 0 });
      setMsg(`Synced: +${totals.added} new, ${totals.updated} updated, −${totals.removed} removed`);
      await loadBookings(properties);
    } finally { setSyncing(false); }
  }

  const hasUnits = properties.some((p) => p.units.length);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Stay<span>Sync</span></div>
        <div className="spacer" />
        <button className="ghost" onClick={() => setStart(addDays(start, -7))}>← week</button>
        <button className="ghost" onClick={() => setStart(addDays(today(), -3))}>Today</button>
        <button className="ghost" onClick={() => setStart(addDays(start, 7))}>week →</button>
        <button className="ghost" onClick={syncAll} disabled={syncing}>{syncing ? 'Syncing…' : '↻ Sync channels'}</button>
        <span className="host">{host.email}</span>
        <button className="ghost" onClick={logout}>Log out</button>
      </header>

      {msg && <div className="banner">{msg}</div>}

      <div className="body">
        <aside className="sidebar">
          <div className="side-head">
            <span>Properties</span>
            <button className="mini" onClick={addProperty}>+ Property</button>
          </div>
          <p className="muted small hint">A <b>property</b> is a building; add <b>units</b> (rooms/apartments) inside it — those are the rows on the grid.</p>
          {properties.map((p) => (
            <div key={p.id} className="prop">
              <div className="prop-name">
                <span>{p.name}</span>
                <button className="del" title="Delete property" onClick={() => deleteProperty(p)}>×</button>
              </div>
              <div className="units">
                {p.units.map((u) => (
                  <span key={u.id} className="unit-chip-wrap">
                    <button className="unit-chip" onClick={() => setPanelUnit(u)}>{u.name}</button>
                    <button className="del sm" title="Delete unit" onClick={() => deleteUnit(u)}>×</button>
                  </span>
                ))}
                <button className="mini" onClick={() => addUnit(p.id)}>+ unit</button>
              </div>
            </div>
          ))}
          {!properties.length && !loading && <p className="muted small">Add your first property to begin.</p>}
        </aside>

        <main className="board-wrap">
          {loading ? (
            <div className="center muted">Loading board…</div>
          ) : !hasUnits ? (
            <div className="center muted">No units yet. Add a property and a unit from the left.</div>
          ) : (
            <Board
              properties={properties}
              bookingsByUnit={bookingsByUnit}
              start={start}
              days={WINDOW_DAYS}
              onNewBooking={(unit) => setBookingCtx({ unit })}
              onEditBooking={(booking, unit) => setBookingCtx({ booking, unit })}
              onOpenUnit={(unit) => setPanelUnit(unit)}
              onAddUnit={addUnit}
            />
          )}
        </main>
      </div>

      {bookingCtx && (
        <BookingModal
          unit={bookingCtx.unit}
          booking={bookingCtx.booking}
          onClose={() => setBookingCtx(null)}
          onSaved={async () => { setBookingCtx(null); await loadBookings(properties); }}
        />
      )}

      {panelUnit && (
        <UnitPanel
          unit={panelUnit}
          onClose={() => setPanelUnit(null)}
          onChanged={async () => { await loadBookings(properties); }}
          onNewBooking={() => { setBookingCtx({ unit: panelUnit }); setPanelUnit(null); }}
        />
      )}
    </div>
  );
}
