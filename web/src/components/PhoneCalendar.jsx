import { useEffect, useMemo, useState } from 'react';
import { api, photoUrl } from '../api.js';

// Phone-only calendar home: one card per unit with its cover photo and a tiny
// picture of this month (a dot per free day, a bar per booking). Tap a card to
// open that unit's full month. Desktop and tablets keep the big board.
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function useIsPhone() {
  const q = '(max-width: 640px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setPhone(mq.matches);
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on);
    return () => (mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on));
  }, []);
  return phone;
}

function MiniMonth({ bookings, y, mo, todayISO }) {
  // Which booking covers each night of the month.
  const byNight = {};
  (bookings || []).forEach((b) => {
    const s = new Date(b.checkIn.slice(0, 10) + 'T00:00:00'), e = new Date(b.checkOut.slice(0, 10) + 'T00:00:00');
    for (let d = new Date(s); d < e; d.setDate(d.getDate() + 1)) byNight[iso(d)] = b;
  });
  const days = new Date(y, mo + 1, 0).getDate();
  const cells = [];
  for (let day = 1; day <= days; day++) {
    const ds = iso(new Date(y, mo, day));
    const prev = iso(new Date(y, mo, day - 1)), next = iso(new Date(y, mo, day + 1));
    const b = byNight[ds];
    const col = (day - 1) % 7;
    const cls = ['mm-c'];
    if (b) {
      cls.push('bar');
      if (byNight[prev] !== b || col === 0) cls.push('s');
      if (byNight[next] !== b || col === 6 || day === days) cls.push('e');
      if (b.checkOut.slice(0, 10) <= todayISO) cls.push('past');
    }
    if (ds === todayISO) cls.push('is-today');
    cells.push(<span key={ds} className={cls.join(' ')}><i /></span>);
  }
  return <div className="mm-grid" aria-hidden="true">{cells}</div>;
}

export default function PhoneCalendar({ properties, onOpenUnit }) {
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth();
  const todayISO = iso(now);
  const units = useMemo(() => properties.flatMap((p) => p.units.map((u) => ({
    ...u, propertyName: p.name, single: p.units.length === 1, photo: u.coverPhotoId || p.coverPhotoId,
  }))), [properties]);
  const [byUnit, setByUnit] = useState({});

  useEffect(() => {
    let live = true;
    const from = iso(new Date(y, mo, 1)), to = iso(new Date(y, mo + 1, 1));
    Promise.all(units.map((u) => api.unitBookings(u.id, from, to)
      .then((r) => [u.id, (r.bookings || r || []).filter((b) => b.status !== 'cancelled')])
      .catch(() => [u.id, []])))
      .then((entries) => { if (live) setByUnit(Object.fromEntries(entries)); });
    return () => { live = false; };
  }, [units, y, mo]);

  const monthName = now.toLocaleDateString('en-ZA', { month: 'long' });
  return (
    <div className="pc-list">
      <h1 className="pc-title">Calendars</h1>
      <p className="muted small pc-sub">{monthName} at a glance · tap a listing to open its calendar</p>
      {units.map((u) => {
        const sub = u.single ? (u.name && u.name !== u.propertyName ? `Unit ${u.name}` : '') : `Unit ${u.name}`;
        return (
          <button key={u.id} className="pc-card" onClick={() => onOpenUnit(u)}>
            {u.photo
              ? <img className="pc-photo" src={photoUrl(u.photo)} alt="" loading="lazy" />
              : <span className="pc-photo pc-ph">{(u.propertyName || '?').slice(0, 1)}</span>}
            <span className="pc-name">
              <b>{u.propertyName}</b>
              {sub && <span className="muted">{sub}</span>}
            </span>
            {byUnit[u.id] ? <MiniMonth bookings={byUnit[u.id]} y={y} mo={mo} todayISO={todayISO} /> : <span className="mm-grid" />}
          </button>
        );
      })}
    </div>
  );
}
