import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api, IS_LIVE } from '../api.js';
import { useRoute, navigate, match, BASE, GUEST_SITE } from '../router.js';
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
import HostNav from './HostNav.jsx';
import MenuView from './MenuView.jsx';
import TodayView from './TodayView.jsx';
import FormChime from './FormChime.jsx';
import ServiceProvidersView from './ServiceProvidersView.jsx';
import GuestBookView from './GuestBookView.jsx';
import PaymentHistoryView from './PaymentHistoryView.jsx';
import SmartLockView from './SmartLockView.jsx';
import AccountView from './AccountView.jsx';
import DocumentsView from './DocumentsView.jsx';
import { BusinessDetails } from './BillerSettings.jsx';
import AdminView from './AdminView.jsx';
import MarketView from './MarketView.jsx';
import MessagesView from './MessagesView.jsx';

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
  const [drawer, setDrawer] = useState(null); // 'property' | 'booking' — the properties/bookings side panel
  const [groups, setGroups] = useState([]);
  const [cleaners, setCleaners] = useState([]);
  const [switching, setSwitching] = useState(false);
  const [teachCount, setTeachCount] = useState(0); // Ask Simon questions waiting for an answer
  const loadTeachCount = useCallback(() => {
    api.teachCount().then((r) => setTeachCount(r.count)).catch(() => {});
  }, []);
  useEffect(() => { loadTeachCount(); const t = setInterval(loadTeachCount, 60000); return () => clearInterval(t); }, [loadTeachCount]);
  const [focus, setFocus] = useState(null); // { unitId, bookingId, key } — jump target
  const route = useRoute();
  // From the bell, a toast or Today, which can fire over any screen.
  function openFormsSubmission(id) { navigate(id ? `/reports/${encodeURIComponent(id)}` : '/reports'); }
  function openMessage(bookingId) { navigate(bookingId ? `/inbox?booking=${encodeURIComponent(bookingId)}` : '/inbox'); }

  // One account: hop to the travelling side signed in. Served at /hosting the
  // two sides share this domain, so the guest session is handed over in
  // localStorage; if one can't be made (a separate guest password already
  // exists), the guest site simply asks them to sign in.
  async function switchToTravelling() {
    setSwitching(true);
    if (BASE) {
      try {
        if (!localStorage.getItem('ss_guest')) {
          const r = await api.guestSession();
          localStorage.setItem('ss_guest', JSON.stringify({ token: r.token, account: r.account }));
        }
      } catch { /* sign in on the travelling side instead */ }
    }
    window.location.href = GUEST_SITE + '/';
  }
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
      // names. Gated to the live site so a local dev server never consumes the
      // shared mailbox before live sees the emails.
      let nameMsg = '';
      if (IS_LIVE) {
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
  const isAdmin = !!host?.isAdmin && !impersonating;
  const allUnits = properties.flatMap((p) => p.units.map((u) => ({ ...u, label: `${p.name} · ${u.name}` })));
  const { path, query } = route;

  function signOut() { try { localStorage.removeItem('ss_guest'); } catch { /* ignore */ } logout(); navigate('/', { replace: true }); }

  // ---- Which screen: every screen has its own address under /hosting ----
  const section = path === '/' ? 'today'
    : path.startsWith('/calendar') ? 'calendar'
    : path.startsWith('/listings') ? 'listings'
    : path.startsWith('/inbox') ? 'inbox'
    : 'menu';

  const LISTING_TABS = [['/listings', 'Listings'], ['/listings/pricing', 'Pricing'], ['/listings/documents', 'House documents'], ['/listings/locks', 'Smart locks']];
  const MONEY_TABS = [['/money', 'Payouts'], ['/money/invoices', 'Invoices'], ['/money/billing', 'Billing details']];
  const tabs = (items, extra) => (
    <div className="section-tabs" role="tablist">
      {items.map(([to, label]) => {
        const on = to === path || (to !== items[0][0] && path.startsWith(to + '/'));
        return <button key={to} role="tab" aria-selected={on} className={on ? 'on' : ''} onClick={() => navigate(to)}>{label}</button>;
      })}
      {extra}
    </div>
  );
  const toCalendar = () => navigate('/calendar');

  let screen;
  let m;
  if (path === '/') {
    screen = <TodayView properties={properties} teachCount={teachCount} onOpenBooking={(booking, unit) => setBookingCtx({ booking, unit })} />;
  } else if ((m = match('/calendar/unit/:unitId', path))) {
    const p = properties.find((pp) => pp.units.some((u) => u.id === m.unitId));
    const unit = p && p.units.find((u) => u.id === m.unitId);
    screen = unit
      ? <UnitMonthView key={unit.id} unit={unit} propertyName={p.name} units={allUnits} groups={groups} cleaners={cleaners} onClose={toCalendar} onBookingsChanged={() => loadBookings(properties)} />
      : <div className="center muted">{loading ? 'Loading…' : 'That unit no longer exists.'}</div>;
  } else if (path === '/calendar') {
    screen = (
      <div className="app">
        <header className="topbar">
          <span className="host">Calendar</span>
          {hasUnits && <BoardSearch onJump={jumpToBooking} onJumpDate={jumpToDate} />}
          <div className="spacer" />
          <button className="ghost" onClick={() => setStart(addMonths(start, -1))}>‹ month</button>
          <button className="ghost" onClick={() => setStart(addDays(start, -7))}>← week</button>
          <button className="ghost" onClick={() => setStart(addDays(today(), -3))}>Today</button>
          <button className="ghost" onClick={() => setStart(addDays(start, 7))}>week →</button>
          <button className="ghost" onClick={() => setStart(addMonths(start, 1))}>month ›</button>
          <button className="ghost" onClick={syncAll} disabled={syncing}>{syncing ? 'Syncing…' : '↻ Sync channels'}</button>
          <button className="ghost" onClick={() => setDrawer('booking')}>＋ Booking</button>
        </header>
        {syncFailed && <div className="banner sync-failed">⚠ Unable to sync — correct as at {fmtSyncTime(lastSynced)}</div>}
        {msg && !syncFailed && <div className="banner">{msg}</div>}
        <div className="body">
          <main className="board-wrap">
            {loading && !hasUnits ? (
              <div className="center muted">Loading calendar…</div>
            ) : !hasUnits ? (
              <div className="center muted">
                No units yet. <button className="linklike" onClick={() => setDrawer('property')}>Add a property and its units</button> to start your calendar.
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
                onOpenUnit={(unit) => navigate(`/calendar/unit/${unit.id}`)}
                onAddUnit={addUnit}
              />
            )}
          </main>
        </div>
      </div>
    );
  } else if (path === '/listings') {
    screen = <>{tabs(LISTING_TABS, <button className="section-tabs-extra" onClick={() => setDrawer('property')}>Properties &amp; units</button>)}<ListingsView onClose={toCalendar} /></>;
  } else if (path === '/listings/pricing') {
    screen = <>{tabs(LISTING_TABS)}<RateCardMatrix onClose={toCalendar} /></>;
  } else if (path === '/listings/documents') {
    screen = <>{tabs(LISTING_TABS)}<DocumentsView onClose={toCalendar} /></>;
  } else if (path === '/listings/locks') {
    screen = <>{tabs(LISTING_TABS)}<SmartLockView onClose={toCalendar} /></>;
  } else if (path === '/inbox' || (m = match('/inbox/:tab', path))) {
    const tab = (m && m.tab) || 'inbox';
    const bookingId = query.get('booking');
    screen = (
      <MessagesView
        key={bookingId || 'inbox'}
        onClose={toCalendar}
        properties={properties.map((p) => ({ id: p.id, name: p.name, units: p.units }))}
        initialBookingId={bookingId}
        teachCount={teachCount}
        initialTab={tab}
        onUnreadChange={loadTeachCount}
      />
    );
  } else if (path === '/reports' || (m = match('/reports/:id', path))) {
    const id = m ? m.id : null;
    screen = <FormsView key={id || 'list'} onClose={toCalendar} properties={properties} initialSubmissionId={id} />;
  } else if (path === '/team') {
    screen = (
      <ServiceProvidersView
        onClose={toCalendar}
        properties={properties.map((p) => ({ id: p.id, name: p.name, cleanRateCents: p.cleanRateCents }))}
        onChanged={() => { api.listCleaners().then((c) => setCleaners(c.cleaners || [])).catch(() => {}); api.listProperties().then((r) => setProperties(r.properties || [])).catch(() => {}); }}
      />
    );
  } else if (path === '/guests') {
    screen = <GuestBookView onClose={toCalendar} />;
  } else if (path === '/money') {
    screen = <>{tabs(MONEY_TABS)}<PaymentHistoryView onClose={toCalendar} /></>;
  } else if (path === '/money/invoices' || (m = match('/money/invoices/:id', path))) {
    const id = m ? m.id : null;
    screen = <>{tabs(MONEY_TABS)}<InvoicesView key={id || 'list'} initialInvoiceId={id} onClose={toCalendar} /></>;
  } else if (path === '/money/billing') {
    screen = <>{tabs(MONEY_TABS)}<PaymentHistoryView onClose={toCalendar} /><BusinessDetails onClose={() => navigate('/money')} /></>;
  } else if (path === '/insights') {
    screen = <MarketView onClose={toCalendar} />;
  } else if (path === '/settings') {
    screen = <AccountView onClose={toCalendar} />;
  } else if (path === '/admin' && isAdmin) {
    screen = <AdminView onClose={toCalendar} />;
  } else if (path === '/menu') {
    screen = (
      <MenuView
        isAdmin={isAdmin}
        onPropertiesAndUnits={() => setDrawer('property')}
        onFindBooking={() => setDrawer('booking')}
        onSwitchToTravelling={switchToTravelling}
        onLogout={signOut}
      />
    );
  } else {
    // An old or mistyped address: start from Today.
    screen = <TodayView properties={properties} teachCount={teachCount} onOpenBooking={(booking, unit) => setBookingCtx({ booking, unit })} />;
  }

  return (
    <div className="host-shell">
      <FormChime onOpen={openFormsSubmission} onOpenMessage={openMessage} />
      {impersonating && (
        <div className="imp-banner">
          <span>👁 Viewing as <b>{host?.name || host?.email}</b> — you are signed in as this host.</span>
          <button onClick={stopImpersonating}>↩ Return to my admin account</button>
        </div>
      )}
      <HostNav
        section={section}
        host={host}
        inboxCount={teachCount}
        onSwitchToTravelling={switchToTravelling}
        switching={switching}
        onLogout={signOut}
        onOpenReport={openFormsSubmission}
        onOpenMessage={openMessage}
      />
      <div className="host-screen">{screen}</div>

      {bookingCtx && (
        <BookingModal
          unit={bookingCtx.unit || null}
          booking={bookingCtx.booking}
          floating={bookingCtx.floating}
          units={allUnits}
          groups={groups}
          cleaners={cleaners}
          onClose={() => setBookingCtx(null)}
          onSaved={async () => { setBookingCtx(null); await loadBookings(properties); }}
          onMessage={(booking) => { setBookingCtx(null); openMessage(booking.id); }}
          onInvoice={async (booking) => {
            const r = await api.createInvoice({ fromBookingId: booking.id });
            setBookingCtx(null);
            navigate(`/money/invoices/${encodeURIComponent(r.invoice.id)}`);
          }}
        />
      )}

      {drawer && (
        <ManageDrawer
          key={drawer}
          initialView={drawer}
          properties={properties}
          bookingsByUnit={bookingsByUnit}
          groups={groups}
          onAssignGroup={assignGroup}
          onCreateGroup={createGroup}
          onClose={() => setDrawer(null)}
          onAddProperty={addProperty}
          onRenameProperty={renameProperty}
          onDeleteProperty={deleteProperty}
          onAddUnit={addUnit}
          onDeleteUnit={deleteUnit}
          onOpenUnit={(unit) => { setDrawer(null); setPanelUnit(unit); }}
          onOpenPricing={() => { setDrawer(null); navigate('/listings/pricing'); }}
          onAddBooking={(unit) => { setDrawer(null); setBookingCtx({ unit }); }}
          onAddFloating={() => { setDrawer(null); setBookingCtx({ floating: true }); }}
          onEditBooking={(booking, unit) => { setDrawer(null); setBookingCtx({ booking, unit }); }}
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
