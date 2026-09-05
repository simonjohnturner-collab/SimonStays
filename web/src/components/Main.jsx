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
import RateCardMatrix from './RateCardMatrix.jsx';
import ListingsView from './ListingsView.jsx';
import BoardSearch from './BoardSearch.jsx';
import FormsView from './FormsView.jsx';
import NotificationsBell from './NotificationsBell.jsx';
import CleanersModal from './CleanersModal.jsx';

const WINDOW_DAYS = 35;

export default function Main() {
  const { host, logout } = useAuth();
  const [properties, setProperties] = useState([]);
  const [bookingsByUnit, setBookingsByUnit] = useState({});
  const [floatingBookings, setFloatingBookings] = useState([]);
  const [start, setStart] = useState(() => addDays(today(), -3));
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const [bookingCtx, setBookingCtx] = useState(null); // { unit } | { booking, unit }
  const [panelUnit, setPanelUnit] = useState(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [invoices, setInvoices] = useState(null); // { initialId } when open
  const [groups, setGroups] = useState([]);
  const [cleaners, setCleaners] = useState([]);
  const [cleanersOpen, setCleanersOpen] = useState(false);
  const [pricingMatrix, setPricingMatrix] = useState(false);
  const [listings, setListings] = useState(false);
  const [forms, setForms] = useState(false);
  const [formsInitialId, setFormsInitialId] = useState(null); // open Forms straight to this submission
  const [focus, setFocus] = useState(null); // { unitId, bookingId, key } — jump target
  function openFormsSubmission(id) { setFormsInitialId(id || null); setForms(true); }
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
    try { const f = await api.listFloating(from, to); setFloatingBookings(f.bookings); } catch { setFloatingBookings([]); }
  }, [from, to]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [r, g, c] = await Promise.all([
        api.listProperties(),
        api.listGroups().catch(() => ({ groups: [] })),
        api.listCleaners().catch(() => ({ cleaners: [] })),
      ]);
      setProperties(r.properties);
      setGroups(g.groups || []);
      setCleaners(c.cleaners || []);
      await loadBookings(r.properties);
    } finally { setLoading(false); }
  }, [loadBookings]);

  async function createGroup() {
    const name = window.prompt('New pricing group name (e.g. Firenza, or Studios)');
    if (!name || !name.trim()) return null;
    const { group } = await api.createGroup(name.trim());
    await refresh();
    return group;
  }
  async function assignGroup(unitId, pricingGroupId) {
    await api.assignUnitGroup(unitId, pricingGroupId || null);
    refresh();
  }
  async function reorderProperties(ids) {
    setProperties((ps) => ids.map((id) => ps.find((p) => p.id === id)).filter(Boolean)); // optimistic
    try { await api.reorderProperties(ids); } catch { /* keep optimistic */ }
    refresh();
  }

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
      // On the live site, pressing Sync also checks the Airbnb mailbox for guest
      // names. Gated to the live build (VITE_API_BASE set) so a local dev server
      // never consumes the shared mailbox before live sees the emails.
      let nameMsg = '';
      if (import.meta.env.VITE_API_BASE) {
        try { const p = await api.pollEmail(); if (p && p.updated) nameMsg = `, +${p.updated} guest name${p.updated > 1 ? 's' : ''}`; }
        catch { /* best-effort */ }
      }
      setMsg(`Synced: +${totals.added} new, ${totals.updated} updated, −${totals.removed} removed${nameMsg}`);
      await loadBookings(properties);
    } finally { setSyncing(false); }
  }

  // Jump the board to a reservation: scroll its check-in into view (a few days
  // of lead-in) and flash its row.
  function jumpToBooking(r) {
    if (!r?.checkIn) return;
    setStart(addDays(new Date(r.checkIn), -3));
    setFocus({ unitId: r.unitId, bookingId: r.id, key: Date.now() });
  }

  const hasUnits = properties.some((p) => p.units.length);

  if (invoices) {
    return <InvoicesView initialInvoiceId={invoices.initialId} onClose={() => setInvoices(null)} />;
  }
  if (pricingMatrix) {
    return <RateCardMatrix onClose={() => setPricingMatrix(false)} />;
  }
  if (listings) {
    return <ListingsView onClose={() => setListings(false)} />;
  }
  if (forms) {
    return <FormsView onClose={() => { setForms(false); setFormsInitialId(null); }} properties={properties} initialSubmissionId={formsInitialId} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="ghost hamburger" title="Manage properties" onClick={() => setMenuOpen(true)}>☰</button>
        <div className="brand">Simon<span>Stays</span></div>
        {hasUnits && <BoardSearch onJump={jumpToBooking} />}
        <div className="spacer" />
        <button className="ghost" onClick={() => setStart(addDays(start, -7))}>← week</button>
        <button className="ghost" onClick={() => setStart(addDays(today(), -3))}>Today</button>
        <button className="ghost" onClick={() => setStart(addDays(start, 7))}>week →</button>
        <button className="ghost" onClick={syncAll} disabled={syncing}>{syncing ? 'Syncing…' : '↻ Sync channels'}</button>
        <button className="ghost" onClick={() => setListings(true)}>🏠 Listings</button>
        <button className="ghost" onClick={() => setEmailOpen(true)}>✉ Guest name</button>
        <NotificationsBell onOpen={openFormsSubmission} />
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
              floatingBookings={floatingBookings}
              start={start}
              days={WINDOW_DAYS}
              focus={focus}
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
          unit={bookingCtx.unit || null}
          booking={bookingCtx.booking}
          floating={bookingCtx.floating}
          units={properties.flatMap((p) => p.units.map((u) => ({ ...u, label: `${p.name} · ${u.name}` })))}
          groups={groups}
          cleaners={cleaners}
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
          groups={groups}
          onAssignGroup={assignGroup}
          onCreateGroup={createGroup}
          onClose={() => setMenuOpen(false)}
          onAddProperty={addProperty}
          onRenameProperty={renameProperty}
          onDeleteProperty={deleteProperty}
          onAddUnit={addUnit}
          onDeleteUnit={deleteUnit}
          onOpenUnit={(unit) => { setMenuOpen(false); setPanelUnit(unit); }}
          onAddBooking={(unit) => { setMenuOpen(false); setBookingCtx({ unit }); }}
          onAddFloating={() => { setMenuOpen(false); setBookingCtx({ floating: true }); }}
          onEditBooking={(booking, unit) => { setMenuOpen(false); setBookingCtx({ booking, unit }); }}
          onOpenInvoices={() => { setMenuOpen(false); setInvoices({ initialId: null }); }}
          onOpenPricing={() => { setMenuOpen(false); setPricingMatrix(true); }}
          onOpenListings={() => { setMenuOpen(false); setListings(true); }}
          onOpenForms={() => { setMenuOpen(false); setForms(true); }}
          onOpenCleaners={() => { setMenuOpen(false); setCleanersOpen(true); }}
          onReorderProperties={reorderProperties}
        />
      )}

      {cleanersOpen && (
        <CleanersModal cleaners={cleaners} onClose={() => setCleanersOpen(false)} onSaved={(list) => setCleaners(list)} />
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
        />
      )}
    </div>
  );
}
