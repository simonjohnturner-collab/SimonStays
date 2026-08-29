import { useMemo } from 'react';
import { range, ymd, weekday, dayMonth, isWeekend } from '../dates.js';

// Build a per-date cell map for one unit's bookings.
function coverage(bookings) {
  const map = {}; // ymd -> { name, blue, red, floating, booking }
  for (const b of bookings) {
    if (b.status === 'cancelled') continue;
    const start = new Date(b.checkIn);
    const end = new Date(b.checkOut);
    const floating = b.status === 'floating';
    for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
      const key = ymd(d);
      const isCheckout = key === ymd(end);
      map[key] = {
        name: b.guestName || (b.source === 'manual' ? '(guest)' : 'Booked'),
        blue: isCheckout && !floating,
        red: !b.paid,
        floating,
        booking: b,
      };
    }
  }
  return map;
}

export default function Board({ properties, bookingsByUnit, start, days, onNewBooking, onEditBooking, onOpenUnit, onAddUnit }) {
  const dates = useMemo(() => range(start, days), [start, days]);
  // Include properties with no units as a placeholder row, so adding one is visible.
  const rows = properties.flatMap((p) =>
    p.units.length
      ? p.units.map((u) => ({ ...u, propertyName: p.name }))
      : [{ placeholder: true, id: `empty-${p.id}`, propertyId: p.id, name: '', propertyName: p.name }]
  );

  return (
    <div className="board-scroll">
      <table className="board">
        <thead>
          <tr>
            <th className="corner" colSpan={2}>Unit</th>
            {dates.map((d) => (
              <th key={ymd(d)} className={isWeekend(d) ? 'weekend' : ''}>
                <div className="wd">{weekday(d)}</div>
                <div className="dm">{dayMonth(d)}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((u, i) => {
            const first = i === 0 || rows[i - 1].propertyName !== u.propertyName;
            if (u.placeholder) {
              return (
                <tr key={u.id}>
                  <th className={`prop-cell ${first ? 'sep' : ''}`}>{first ? u.propertyName : ''}</th>
                  <th className="unit-cell">
                    <button className="unit-link add" onClick={() => onAddUnit(u.propertyId)}>+ unit</button>
                  </th>
                  <td className="cell empty-row" colSpan={dates.length}>No units yet — click “+ unit” to add one.</td>
                </tr>
              );
            }
            const cov = coverage(bookingsByUnit[u.id] || []);
            return (
              <tr key={u.id}>
                <th className={`prop-cell ${first ? 'sep' : ''}`}>{first ? u.propertyName : ''}</th>
                <th className="unit-cell">
                  <button className="unit-link" onClick={() => onOpenUnit(u)} title="Channels & feed">{u.name}</button>
                </th>
                {dates.map((d) => {
                  const key = ymd(d);
                  const c = cov[key];
                  const cls = ['cell'];
                  if (isWeekend(d)) cls.push('weekend');
                  if (c?.blue) cls.push('blue');
                  if (c?.floating) cls.push('yellow');
                  return (
                    <td
                      key={key}
                      className={cls.join(' ')}
                      onClick={() => (c ? onEditBooking(c.booking, u) : onNewBooking(u))}
                      title={c ? cellTitle(c) : 'Click to add a booking'}
                    >
                      {c && <span className={c.red ? 'name red' : 'name'}>{c.name}</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="legend">
        <span><i className="sw blue" /> Checkout day — clean needed</span>
        <span><i className="sw yellow" /> Floating booking</span>
        <span><i className="sw red-text">Aa</i> Payment not allocated</span>
        <span className="muted">Click a booking to edit · an empty cell to add</span>
      </div>
    </div>
  );
}

function cellTitle(c) {
  const b = c.booking;
  const paid = b.paid ? 'paid' : 'UNPAID';
  return `${c.name} · ${b.checkIn.slice(0, 10)} → ${b.checkOut.slice(0, 10)} · ${b.source} · ${paid}` +
    (b.cleaner ? ` · cleaner: ${b.cleaner}` : '') + (b.comments ? `\n${b.comments}` : '');
}
