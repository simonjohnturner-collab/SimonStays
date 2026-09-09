import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { centsToRand, randToCents, fmtR } from '../money.js';
import BookingModal from './BookingModal.jsx';

// A single-unit monthly calendar: click a unit number on the board to see just
// that unit's bookings. Edit/create bookings in place, and select empty nights
// to override their base price (rate-card price otherwise).
const iso = (d) => d.toISOString().slice(0, 10);
const firstOfMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; };

export default function UnitMonthView({ unit, propertyName, onClose, units = [], groups = [], cleaners = [], onBookingsChanged }) {
  const [month, setMonth] = useState(firstOfMonth());
  const [bookings, setBookings] = useState(null);
  const [rates, setRates] = useState({}); // iso -> { cents, overridden }
  const [hasPricing, setHasPricing] = useState(true);
  const [sel, setSel] = useState(() => new Set()); // selected free nights (iso)
  const [priceInput, setPriceInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState(null); // { booking } or { neww:true } for the modal

  const y = month.getFullYear(), mo = month.getMonth();
  const rangeFrom = iso(new Date(y, mo, -6));
  const rangeTo = iso(new Date(y, mo + 1, 7));

  async function load() {
    try {
      const [b, r] = await Promise.all([
        api.unitBookings(unit.id, rangeFrom, rangeTo),
        api.getNightRates(unit.id, iso(new Date(y, mo, 1)), iso(new Date(y, mo + 1, 0))).catch(() => ({ nights: [], hasPricing: false })),
      ]);
      setBookings((b.bookings || b || []).filter((x) => x.status !== 'cancelled'));
      const m = {}; (r.nights || []).forEach((nr) => { m[nr.date] = nr; }); setRates(m); setHasPricing(r.hasPricing);
    } catch (e) { setMsg(e.message); setBookings([]); }
  }
  useEffect(() => { load(); setSel(new Set()); /* eslint-disable-next-line */ }, [unit.id, month]);

  const nights = useMemo(() => {
    const m = {};
    (bookings || []).forEach((b) => {
      const s = new Date(b.checkIn.slice(0, 10) + 'T00:00:00'), e = new Date(b.checkOut.slice(0, 10) + 'T00:00:00');
      for (let d = new Date(s); d < e; d.setDate(d.getDate() + 1)) m[iso(d)] = b;
    });
    return m;
  }, [bookings]);

  const startDow = new Date(y, mo, 1).getDay();
  const days = new Date(y, mo + 1, 0).getDate();
  const label = month.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
  const todayISO = iso(new Date());
  const isRed = (b) => b && b.paymentStatus && b.paymentStatus !== 'paid' && b.source !== 'airbnb';

  function toggle(ds) { setSel((s) => { const n = new Set(s); n.has(ds) ? n.delete(ds) : n.add(ds); return n; }); }

  async function applyPrice(clear) {
    if (sel.size === 0) return;
    if (!clear && priceInput === '') { setMsg('Enter a price first.'); return; }
    setBusy(true); setMsg('');
    try {
      await api.setNightPrices(unit.id, [...sel], clear ? null : randToCents(priceInput));
      setSel(new Set()); setPriceInput('');
      await load();
      flash(clear ? 'Override cleared.' : 'Price updated for selected nights.');
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 1600); }

  async function onSaved() { setEdit(null); await load(); onBookingsChanged && onBookingsChanged(); }

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(<div key={'p' + i} className="um-day pad" />);
  for (let day = 1; day <= days; day++) {
    const ds = iso(new Date(y, mo, day));
    const b = nights[ds];
    const isCheckIn = b && b.checkIn.slice(0, 10) === ds;
    const nr = rates[ds];
    const selected = sel.has(ds);
    cells.push(
      <div key={ds}
        className={`um-day ${b ? 'booked' : 'free'} ${selected ? 'sel' : ''} ${ds === todayISO ? 'today' : ''}`}
        onClick={() => (b ? setEdit({ booking: b }) : toggle(ds))}
        title={b ? `${b.guestName || 'Booking'} · ${b.checkIn.slice(0, 10)} → ${b.checkOut.slice(0, 10)}` : (selected ? 'Selected — set a price below' : 'Click to select this night')}>
        <span className="um-num">{day}</span>
        {b ? (
          isCheckIn ? <span className={`um-guest ${isRed(b) ? 'owing' : ''}`}>{b.guestName || '(guest)'}</span> : <span className="um-cont">•</span>
        ) : (
          nr && nr.cents != null ? <span className={`um-price ${nr.overridden ? 'ovr' : ''}`}>{fmtR(nr.cents)}</span> : null
        )}
      </div>
    );
  }

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">{propertyName ? propertyName + ' · ' : ''}Unit {unit.name}</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={() => setEdit({ neww: true })}>＋ Booking</button>
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="um-wrap">
        <div className="um-head">
          <button className="um-nav" onClick={() => setMonth(new Date(y, mo - 1, 1))}>‹ Previous month</button>
          <h3>{label} <button className="um-today" onClick={() => setMonth(firstOfMonth())}>Today</button></h3>
          <button className="um-nav" onClick={() => setMonth(new Date(y, mo + 1, 1))}>Next month ›</button>
        </div>

        {sel.size > 0 && (
          <div className="um-pricebar">
            <span><b>{sel.size}</b> night{sel.size > 1 ? 's' : ''} selected · set the base nightly price</span>
            <span className="spacer" />
            <span className="rand-in">R<input type="number" min="0" value={priceInput} placeholder="0.00" onChange={(e) => setPriceInput(e.target.value)} /></span>
            <button disabled={busy} onClick={() => applyPrice(false)}>{busy ? '…' : 'Apply'}</button>
            <button className="secondary" disabled={busy} onClick={() => applyPrice(true)}>Clear override</button>
            <button className="ghost dark" onClick={() => setSel(new Set())}>Cancel</button>
          </div>
        )}

        {!bookings ? <p className="muted small">Loading…</p> : (
          <>
            <div className="um-grid um-dows">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="um-dow">{d}</div>)}</div>
            <div className="um-grid">{cells}</div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Click a <b>booked</b> day to edit it, or <b>＋ Booking</b> to add one. Click <b>empty</b> days to select them, then set a custom base price (overrides the rate card for those nights only — cleaning, deposit &amp; fees are unchanged).
              {!hasPricing && <> This unit has no pricing group, so rate-card prices aren’t shown.</>}
            </p>
          </>
        )}
      </div>

      {edit && (
        <BookingModal
          unit={unit}
          booking={edit.booking || null}
          units={units}
          groups={groups}
          cleaners={cleaners}
          onClose={() => setEdit(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
