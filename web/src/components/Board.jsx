import { useMemo } from 'react';
import { range, ymd, weekday, dayMonth, isWeekend } from '../dates.js';

// Build a per-date cell map for one unit's bookings.
// Occupancy (guest name) covers the nights stayed: check-in .. check-out-1.
// The check-out day itself is the departure morning — clean needed, and free for
// a new check-in — so it gets a blue highlight with NO guest name.
function coverage(bookings) {
  const map = {}; // ymd -> { name, blue, red, floating, booking, early, lateCheckout, cleanerCheckout, checkoutBooking, insta[] }
  const ensure = (key) => (map[key] = map[key] || {});
  for (const b of bookings) {
    if (b.status === 'cancelled') continue;
    const start = new Date(b.checkIn);
    const end = new Date(b.checkOut);
    const floating = b.status === 'floating';

    // Nights actually occupied (name shown).
    for (let d = new Date(start); d.getTime() < end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
      const cell = ensure(ymd(d));
      cell.name = b.guestName || (b.source === 'manual' ? '(guest)' : 'Booked');
      cell.red = !b.paid;
      cell.floating = floating;
      cell.booking = b;
    }

    // Early check-in → flag the check-in cell.
    if (b.earlyCheckIn) ensure(ymd(start)).early = true;

    // Check-out day: blue clean cell (no name), plus the checkout cleaner + late flag.
    if (!floating) {
      const cell = ensure(ymd(end));
      cell.blue = true;
      cell.cleanerCheckout = b.cleaner || null;
      cell.lateCheckout = !!b.lateCheckOut;
      cell.checkoutBooking = b;
      if (!cell.booking) cell.booking = b;
    }

    // Insta (mid-stay) cleans → marker on their date.
    (b.cleans || []).forEach((cl) => {
      if (!cl.date) return;
      const cell = ensure(ymd(new Date(cl.date)));
      (cell.insta = cell.insta || []).push({ cleaner: cl.cleaner, paymentMethod: cl.paymentMethod });
    });
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
                  const hasGuest = !!(c && c.name);
                  const cls = ['cell'];
                  if (isWeekend(d)) cls.push('weekend');
                  if (c?.blue) cls.push('blue');
                  if (c?.floating) cls.push('yellow');
                  if (c?.early) cls.push('early');
                  if (c?.blue && c?.lateCheckout) cls.push('late');
                  if (c?.blue && !c?.cleanerCheckout) cls.push('needs-cleaner');
                  return (
                    <td
                      key={key}
                      className={cls.join(' ')}
                      onClick={() => (hasGuest ? onEditBooking(c.booking, u) : onNewBooking(u))}
                      title={hasGuest ? cellTitle(c) : c?.blue ? 'Checkout — clean needed · free for a new check-in' : 'Click to add a booking'}
                    >
                      {c?.early && <span className="badge early" title="Early check-in">⏰</span>}
                      {hasGuest && <span className={c.red ? 'name red' : 'name'}>{c.name}</span>}
                      {c?.insta?.length > 0 && (
                        <span className="cico insta" title={instaTitle(c.insta)}>🧽</span>
                      )}
                      {c?.blue && (
                        <span
                          className={`cico clean ${c.cleanerCheckout ? '' : 'unassigned'} ${hasGuest ? '' : 'centered'}`}
                          title={(c.cleanerCheckout ? `Checkout clean: ${c.cleanerCheckout}` : 'Checkout clean — click to assign a cleaner')
                            + (c.lateCheckout ? '\n⏰ Late checkout' : '')}
                          onClick={(e) => { e.stopPropagation(); onEditBooking(c.checkoutBooking, u); }}
                        >🧹</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="legend">
        <span><i className="sw blue" /> Checkout — clean needed</span>
        <span><i className="sw needs-cleaner-sw" /> cleaner not allocated</span>
        <span>🧹 checkout cleaner <span className="muted">(hover)</span></span>
        <span>🧽 insta clean</span>
        <span><i className="sw early-sw" /> ⏰ early check-in</span>
        <span><i className="sw late-sw" /> late checkout</span>
        <span><i className="sw red-text">Aa</i> unpaid</span>
      </div>
    </div>
  );
}

function cellTitle(c) {
  const b = c.booking;
  const paid = b.paid ? 'paid' : 'UNPAID';
  const reqs = [];
  if (b.earlyCheckIn) reqs.push('early check-in');
  if (b.lateCheckOut) reqs.push('late check-out');
  if (b.extraMattress) reqs.push('extra mattress');
  if (b.hairDryer) reqs.push('hair dryer');
  if (b.cleans?.length) reqs.push(`${b.cleans.length} insta clean${b.cleans.length > 1 ? 's' : ''}`);
  return `${c.name} · ${b.checkIn.slice(0, 10)} → ${b.checkOut.slice(0, 10)} · ${b.source} · ${paid}` +
    (b.cleaner ? ` · checkout cleaner: ${b.cleaner}` : '') +
    (reqs.length ? `\nRequests: ${reqs.join(', ')}` : '') +
    (b.comments ? `\n${b.comments}` : '');
}

function instaTitle(insta) {
  return 'Insta clean:\n' + insta.map((c) =>
    `• ${c.cleaner || 'cleaner TBD'} — ${c.paymentMethod === 'direct' ? 'paid directly to cleaner' : 'paid for'}`
  ).join('\n');
}
