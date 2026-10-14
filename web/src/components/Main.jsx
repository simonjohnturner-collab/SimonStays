import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { today, addDays, addMonths, ymd } from '../dates.js';
import Board from './Board.jsx';
import BookingModal from './BookingModal.jsx';
import UnitPanel from './UnitPanel.jsx';
import UnitMonthView from './UnitMonthView.jsx';
import ManageDrawer from './ManageDrawer.jsx';
import InvoicesView from './InvoicesView.jsx';
import RateCardMatrix from './RateCardMatrix.jsx';
import ListingsView from './ListingsView.jsx';
import BoardSearch from './BoardSearch.jsx';
import FormsView from './FormsView.jsx';
import NotificationsBell from './NotificationsBell.jsx';
import FormChime from './FormChime.jsx';
import ServiceProvidersView from './ServiceProvidersView.jsx';
import GuestBookView from './GuestBookView.jsx';
import PaymentHistoryView from './PaymentHistoryView.jsx';
import SmartLockView from './SmartLockView.jsx';
import AccountView from './AccountView.jsx';
import AdminView from './AdminView.jsx';
import MarketView from './MarketView.jsx';

const WINDOW_DAYS = 35;
const LAST_SYNC_KEY = 'staysync_last_sync';

function readLastSync() {
  try { return localStorage.getItem(LAST_SYNC_KEY) || null; } catch { return null; }
}
function fmtSyncTime(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Main() {
  const { host, logout, impersonating, stopImpersonating } = useAuth();
  const [properties, setProperties] = useState([]);
  const [bookingsByUnit, setBookingsByUnit] = useState({});
  const [floatingBookings, setFloatingBookings] = useState([]);
  const [start, setStart] = useState(() => addDays(today(), -3));
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const [bookingCtx, setBookingCtx] = useState(null); // { unit } | { booking, unit }
  const [panelUnit, setPanelUnit] = useState(null);
  const [monthUnit, setMonthUnit] = useState(null); // { unit, propertyName } for the single-unit month view
  const [menuOpen, setMenuOpen] = useState(false);
  const [invoices, setInvoices] = useState(null); // { initialId } when open
  const [groups, setGroups] = useState([]);
  const [cleaners, setCleaners] = useState([]);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  const [pricingMatrix, setPricingMatrix] = useState(false);
  const [listings, setListings] = useState(false);
  const [forms, setForms] = useState(false);
  const [smartLocks, setSmartLocks] = useState(false);
  const [account, setAccount] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [market, setMarket] = useState(false);
  const [formsInitialId, setFormsInitialId] = useState(null); // open Forms straight to this submission
  const [focus, setFocus] = useState(null); // { unitId, bookingId, key } — jump target
  function openFormsSubmission(id) { setFormsInitialId(id || null); setForms(true); }
  const [msg, setMsg] = useState('');
  // When the server/database can't be reached we leave the board exactly as it
  // was and show a red "unable to sync" notice with the last good load time.
  const [syncFailed, setSyncFailed] = useState(false);
  const [lastSynced, setLastSynced] = useState(readLastSync);
  function markSynced() {
    const now = new Date().toISOString();
    setLastSynced(now); setSyncFailed(false);
    try { localStorage.setItem(LAST_SYNC_KEY, now); } catch { /* ignore */ }
  }

  const from = ymd(start);
  const to = ymd(addDays(start, WINDOW_DAYS));

  // Fetch everything first and only replace the board once every request has
  // succeeded — a dropped connection must never blank out the table.
  const loadBookings = useCallback(async (props) => {
    const units = props.flatMap((p) => p.units.map((u) => ({ ...u, propertyName: p.name })));
    try {
      const [entries, f] = await Promise.all([
        Promise.all(units.map(async (u) => { const r = await api.unitBookings(u.id, from, to); return [u.id, r.bookings]; })),
        api.listFloating(from, to),
      ]);
      setBookingsByUnit(Object.fromEntries(entries));
      setFloatingBookings(f.bookings);
      markSynced();
      return true;
    } catch {
      setSyncFailed(true);
      return false;
    }
  }, [from, to]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      let r;
      try { r = await api.listProperties(); }
      catch { setSyncFailed(true); return; } // keep the board as it was
      const [g, c] = await Promise.all([
        api.listGroups().catch(() => null),
        api.listCleaners().catch(() => null),
      ]);
      setProperties(r.properties);
      if (g) setGroups(g.groups || []);
      if (c) setCleaners(c.cleaners || []);
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
      // Nothing came back at all → the server/database is unreachable.
      if (units.length && results.every((r) => r === null)) { setSyncFailed(true); return; }
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
      if (await loadBookings(properties)) {
        setMsg(`Synced: +${totals.added} new, ${totals.updated} updated, −${totals.removed} removed${nameMsg}`);
      }
    } finally { setSyncing(false); }
  }

  // Jump the board to a reservation: scroll its check-in into view (a few days
  // of lead-in) and flash its row.
  function jumpToBooking(r) {
    if (!r?.checkIn) return;
    setStart(addDays(new Date(r.checkIn), -3));
    setFocus({ unitId: r.unitId, bookingId: r.id, key: Date.now() });
  }

  // Reposition the board so the chosen date sits near the left (a few days lead-in).
  function jumpToDate(iso) {
    if (!iso) return;
    setStart(addDays(new Date(iso + 'T12:00:00'), -3));
  }

  const hasUnits = properties.some((p) => p.units.length);

  // Wrap every screen with the impersonation banner so the admin always has a
  // one-click way back to their own account while signed in as another host.
  const withChrome = (el) => (
    <>
      <FormChime onOpen={openFormsSubmission} />
      {impersonating && (
        <div className="imp-banner">
          <span>👁 Viewing as <b>{host?.name || host?.email}</b> — you are signed in as this host.</span>
          <button onClick={stopImpersonating}>↩ Return to my admin account</button>
        </div>
      )}
      {el}
    </>
  );

  if (adminOpen) {
    return withChrome(<AdminView onClose={() => setAdminOpen(false)} />);
  }
  if (market) {
    return withChrome(<MarketView onClose={() => setMarket(false)} />);
  }
  if (invoices) {
    return withChrome(<InvoicesView initialInvoiceId={invoices.initialId} onClose={() => setInvoices(null)} />);
  }
  if (pricingMatrix) {
    return withChrome(<RateCardMatrix onClose={() => setPricingMatrix(false)} />);
  }
  if (listings) {
    return withChrome(<ListingsView onClose={() => setListings(false)} />);
  }
  if (forms) {
    return withChrome(<FormsView onClose={() => { setForms(false); setFormsInitialId(null); }} properties={properties} initialSubmissionId={formsInitialId} />);
  }
  if (smartLocks) {
    return withChrome(<SmartLockView onClose={() => setSmartLocks(false)} />);
  }
  if (account) {
    return withChrome(<AccountView onClose={() => setAccount(false)} />);
  }
  if (providersOpen) {
    return withChrome(
      <ServiceProvidersView
        onClose={() => setProvidersOpen(false)}
        properties={properties.map((p) => ({ id: p.id, name: p.name, cleanRateCents: p.cleanRateCents }))}
        onChanged={() => { api.listCleaners().then((c) => setCleaners(c.cleaners || [])).catch(() => {}); api.listProperties().then((r) => setProperties(r.properties || [])).catch(() => {}); }}
      />
    );
  }
  if (guestsOpen) {
    return withChrome(<GuestBookView onClose={() => setGuestsOpen(false)} />);
  }
  if (paymentsOpen) {
    return withChrome(<PaymentHistoryView onClose={() => setPaymentsOpen(false)} />);
  }
  if (monthUnit) {
    return withChrome(
      <UnitMonthView
        unit={monthUnit.unit}
        propertyName={monthUnit.propertyName}
        units={properties.flatMap((p) => p.units.map((u) => ({ ...u, label: `${p.name} · ${u.name}` })))}
        groups={groups}
        cleaners={cleaners}
        onClose={() => setMonthUnit(null)}
        onBookingsChanged={() => loadBookings(properties)}
      />
    );
  }

  return withChrome(
    <div className="app">
      <header className="topbar">
        <button className="ghost hamburger" title="Manage properties" onClick={() => setMenuOpen(true)}>☰</button>
        <div className="brand">Simon<span>Stays</span></div>
        {hasUnits && <BoardSearch onJump={jumpToBooking} onJumpDate={jumpToDate} />}
        <div className="spacer" />
        <button className="ghost" onClick={() => setStart(addMonths(start, -1))}>‹ month</button>
        <button className="ghost" onClick={() => setStart(addDays(start, -7))}>← week</button>
        <button className="ghost" onClick={() => setStart(addDays(today(), -3))}>Today</button>
        <button className="ghost" onClick={() => setStart(addDays(start, 7))}>week →</button>
        <button className="ghost" onClick={() => setStart(addMonths(start, 1))}>month ›</button>
        <button className="ghost" onClick={syncAll} disabled={syncing}>{syncing ? 'Syncing…' : '↻ Sync channels'}</button>
        <button className="ghost" onClick={() => setListings(true)}>🏠 Listings</button>
        <NotificationsBell onOpen={openFormsSubmission} />
        <span className="host">{host.email}</span>
        <button className="ghost" onClick={logout}>Log out</button>
      </header>

      {syncFailed && (
        <div className="banner sync-failed">
          ⚠ Unable to sync — correct as at {fmtSyncTime(lastSynced)}
        </div>
      )}
      {msg && !syncFailed && <div className="banner">{msg}</div>}

      <div className="body">
        <main className="board-wrap">
          {loading && !hasUnits ? (
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
              onOpenUnit={(unit) => setMonthUnit({ unit, propertyName: (properties.find((p) => p.id === unit.propertyId) || {}).name })}
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
          onOpenMarket={() => { setMenuOpen(false); setMarket(true); }}
          onOpenListings={() => { setMenuOpen(false); setListings(true); }}
          onOpenForms={() => { setMenuOpen(false); setForms(true); }}
          onOpenCleaners={() => { setMenuOpen(false); setProvidersOpen(true); }}
          onOpenGuests={() => { setMenuOpen(false); setGuestsOpen(true); }}
          onOpenSmartLocks={() => { setMenuOpen(false); setSmartLocks(true); }}
          onOpenAccount={() => { setMenuOpen(false); setAccount(true); }}
          onOpenPayments={() => { setMenuOpen(false); setPaymentsOpen(true); }}
          isAdmin={host?.isAdmin && !impersonating}
          onOpenAdmin={() => { setMenuOpen(false); setAdminOpen(true); }}
          onReorderProperties={reorderProperties}
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
