import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// A single-unit monthly calendar: click a unit number on the board to see just
// that unit's bookings, month by month.
const iso = (d) => d.toISOString().slice(0, 10);
const firstOfMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; };

export default function UnitMonthView({ unit, propertyName, onClose, onEditBooking, onNewBooking }) {
  const [month, setMonth] = useState(firstOfMonth());
  const [bookings, setBookings] = useState(null);
  const [msg, setMsg] = useState('');

  async function load() {
    // Pull a little either side of the month so stays spanning the edges show.
    const from = iso(new Date(month.getFullYear(), month.getMonth(), -6));
    const to = iso(new Date(month.getFullYear(), month.getMonth() + 1, 7));
    try { const r = await api.unitBookings(unit.id, from, to); setBookings((r.bookings || r || []).filter((b) => b.status !== 'cancelled')); }
    catch (e) { setMsg(e.message); setBookings([]); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [unit.id, month]);

  // Map each booked NIGHT (checkIn..checkOut-1) to its booking, for quick lookup.
  const nights = useMemo(() => {
    const m = {};
    (bookings || []).forEach((b) => {
      const s = new Date(b.checkIn.slice(0, 10) + 'T00:00:00'), e = new Date(b.checkOut.slice(0, 10) + 'T00:00:00');
      for (let d = new Date(s); d < e; d.setDate(d.getDate() + 1)) m[iso(d)] = b;
    });
    return m;
  }, [bookings]);

  const y = month.getFullYear(), mo = month.getMonth();
  const startDow = new Date(y, mo, 1).getDay();
  const days = new Date(y, mo + 1, 0).getDate();
  const label = month.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
  const todayISO = iso(new Date());
  const isRed = (b) => b && b.paymentStatus && b.paymentStatus !== 'paid' && b.source !== 'airbnb';

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(<div key={'p' + i} className="um-day pad" />);
  for (let day = 1; day <= days; day++) {
    const ds = iso(new Date(y, mo, day));
    const b = nights[ds];
    const isCheckIn = b && b.checkIn.slice(0, 10) === ds;
    cells.push(
      <div key={ds} className={`um-day ${b ? 'booked' : 'free'} ${ds === todayISO ? 'today' : ''}`}
        onClick={() => (b ? onEditBooking(b, unit) : onNewBooking && onNewBooking(unit, ds))}
        title={b ? `${b.guestName || 'Booking'} · ${b.checkIn.slice(0, 10)} → ${b.checkOut.slice(0, 10)}` : 'Add a booking'}>
        <span className="um-num">{day}</span>
        {b && isCheckIn && <span className={`um-guest ${isRed(b) ? 'owing' : ''}`}>{b.guestName || '(guest)'}</span>}
        {b && !isCheckIn && <span className="um-cont">•</span>}
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
        <button className="ghost" onClick={() => onNewBooking && onNewBooking(unit)}>＋ Booking</button>
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="um-wrap">
        <div className="um-head">
          <button className="ghost" onClick={() => setMonth(new Date(y, mo - 1, 1))}>‹ Prev</button>
          <h3>{label}</h3>
          <button className="ghost" onClick={() => setMonth(new Date(y, mo + 1, 1))}>Next ›</button>
        </div>
        {!bookings ? <p className="muted small">Loading…</p> : (
          <>
            <div className="um-grid um-dows">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="um-dow">{d}</div>)}
            </div>
            <div className="um-grid">{cells}</div>
            <p className="muted small" style={{ marginTop: 10 }}>Click a booked day to edit that booking, or an empty day to add one.</p>
          </>
        )}
      </div>
    </div>
  );
}
