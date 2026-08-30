import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { today, addDays, ymd } from '../dates.js';
import Board from './Board.jsx';
import BookingModal from './BookingModal.jsx';
import UnitPanel from './UnitPanel.jsx';
import EmailModal from './EmailModal.jsx';
import ManageDrawer from './ManageDrawer.jsx';
import InvoicesView from './InvoicesView.jsx';
import RateCardModal from './RateCardModal.jsx';

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
  const [emailOpen, setEmailOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [invoices, setInvoices] = useState(null); // { initialId } when open
  const [pricingUnit, setPricingUnit] = useState(null);
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
    const ical = window.prompt('Airbnb iCal link for this property (optional — paste the calendar export URL, or leave blank to add units/channels later):');
    const { property } = await api.createProperty(name.trim());
    if (ical && ical.trim()) {
      try {
        const { unit } = await api.createUnit(property.id, 'Main');
        await api.addChannel(unit.id, 'airbnb', ical.trim());
        await api.syncUnit(unit.id);
      } catch (e) {
        window.alert('Property created, but the iCal link couldn’t be connected: ' + e.message);
      }
    }
    refresh();
  }
  async function addUnit(propertyId) {
    const name = window.prompt('Unit name / number (e.g. 23)');
    if (!name) return;
    await api.createUnit(propertyId, name.trim());
    refresh();
  }
  async function renameProperty(p) {
    const name = window.prompt('Rename property', p.name);
    if (!name || !name.trim() || name.trim() === p.name) return;
    await api.updateProperty(p.id, name.trim());
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

  if (invoices) {
    return <InvoicesView initialInvoiceId={invoices.initialId} onClose={() => setInvoices(null)} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="ghost hamburger" title="Manage properties" onClick={() => setMenuOpen(true)}>☰</button>
        <div className="brand">Simon<span>Stays</span></div>
        <div className="spacer" />
        <button className="ghost" onClick={() => setStart(addDays(start, -7))}>← week</button>
        <button className="ghost" onClick={() => setStart(addDays(today(), -3))}>Today</button>
        <button className="ghost" onClick={() => setStart(addDays(start, 7))}>week →</button>
        <button className="ghost" onClick={syncAll} disabled={syncing}>{syncing ? 'Syncing…' : '↻ Sync channels'}</button>
        <button className="ghost" onClick={() => setEmailOpen(true)}>✉ Guest name</button>
        <span className="host">{host.email}</span>
        <button className="ghost" onClick={logout}>Log out</button>
      </header>

      {msg && <div className="banner">{msg}</div>}

      <div className="body">
        <main className="board-wrap">
          {loading ? (
            <div className="center muted">Loading board…</div>
          ) : !hasUnits ? (
            <div className="center muted">
              No units yet. Open <b>☰ Manage properties</b> (top left) to add a property and units.
            </div>
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
          onInvoice={async (booking) => {
            const r = await api.createInvoice({ fromBookingId: booking.id });
            setBookingCtx(null);
            setInvoices({ initialId: r.invoice.id });
          }}
        />
      )}

      {menuOpen && (
        <ManageDrawer
          properties={properties}
          bookingsByUnit={bookingsByUnit}
          onClose={() => setMenuOpen(false)}
          onAddProperty={addProperty}
          onRenameProperty={renameProperty}
          onDeleteProperty={deleteProperty}
          onAddUnit={addUnit}
          onDeleteUnit={deleteUnit}
          onOpenUnit={(unit) => { setMenuOpen(false); setPanelUnit(unit); }}
          onAddBooking={(unit) => { setMenuOpen(false); setBookingCtx({ unit }); }}
          onEditBooking={(booking, unit) => { setMenuOpen(false); setBookingCtx({ booking, unit }); }}
          onOpenInvoices={() => { setMenuOpen(false); setInvoices({ initialId: null }); }}
          onEditPricing={(u) => { setMenuOpen(false); setPricingUnit(u); }}
        />
      )}

      {pricingUnit && (
        <RateCardModal
          unit={pricingUnit}
          onClose={() => setPricingUnit(null)}
          onSaved={() => setPricingUnit(null)}
        />
      )}

      {emailOpen && (
        <EmailModal
          onClose={() => setEmailOpen(false)}
          onDone={async () => { await loadBookings(properties); }}
        />
      )}

      {panelUnit && (
        <UnitPanel
          unit={panelUnit}
          onClose={() => setPanelUnit(null)}
          onChanged={async () => { await loadBookings(properties); }}
          onNewBooking={() => { setBookingCtx({ unit: panelUnit }); setPanelUnit(null); }}
          onEditPricing={(u) => { setPanelUnit(null); setPricingUnit(u); }}
        />
      )}
    </div>
  );
}
