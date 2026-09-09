import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtR } from '../money.js';

// Payment history: the host's paid bookings with a priced breakdown, so they can
// see what has been paid out (property, dates, extras, and the calculation).
export default function PaymentHistoryView({ onClose }) {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(null); // expanded breakdown id

  useEffect(() => { api.listPayments().then(setData).catch((e) => setMsg(e.message)); }, []);

  const extrasText = (x) => {
    const e = [];
    if (x.earlyCheckIn) e.push('Early check-in');
    if (x.lateCheckOut) e.push('Late checkout');
    if (x.extraMattress) e.push('Extra mattress');
    return e.length ? e.join(', ') : '—';
  };

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Payment history</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="ph-wrap">
        {!data ? <p className="muted small">Loading…</p> : (
          <>
            <div className="ph-total">
              <span>Total paid out to you</span>
              <b>{fmtR(data.totalPaidOutCents)}</b>
              <span className="muted small">across {data.payments.length} paid booking{data.payments.length === 1 ? '' : 's'}</span>
            </div>
            <p className="muted small">The amount paid out is the rental total (accommodation + cleaning + any extras, after discounts). The refundable breakage deposit is shown separately and isn’t part of the payout.</p>

            {data.payments.length === 0 ? (
              <p className="muted small">No paid bookings yet. Website bookings and any bookings marked paid will appear here.</p>
            ) : data.payments.map((p) => {
              const q = p.quote;
              return (
                <section key={p.id} className="ph-card">
                  <div className="ph-top" onClick={() => setOpen(open === p.id ? null : p.id)}>
                    <div className="ph-main">
                      <div className="ph-prop">{p.property} · Unit {p.unit}</div>
                      <div className="ph-sub">{p.checkIn} → {p.checkOut} · {p.guestName || '(guest)'} · <span className="ph-src">{p.source}</span></div>
                      <div className="ph-extras">Extras: {extrasText(p.extras)}</div>
                    </div>
                    <div className="ph-amt">{q ? fmtR(q.rentalCents) : '—'}<span className="ph-caret">{open === p.id ? '▲' : '▼'}</span></div>
                  </div>
                  {open === p.id && (
                    <div className="ph-breakdown">
                      {!q ? <p className="muted small">No rate card on this unit — amount can’t be itemised.</p> : (<>
                        <div className="ph-row"><span>{q.nights} night{q.nights > 1 ? 's' : ''} accommodation</span><span>{fmtR(q.accommodationCents)}</span></div>
                        {q.discountCents ? <div className="ph-row"><span>{q.discountPercent}% length discount</span><span>−{fmtR(q.discountCents)}</span></div> : null}
                        {q.cleaningCents ? <div className="ph-row"><span>Cleaning</span><span>{fmtR(q.cleaningCents)}</span></div> : null}
                        {q.earlyCents ? <div className="ph-row"><span>Early check-in</span><span>{fmtR(q.earlyCents)}</span></div> : null}
                        {q.lateCents ? <div className="ph-row"><span>Late checkout</span><span>{fmtR(q.lateCents)}</span></div> : null}
                        {q.mattressCents ? <div className="ph-row"><span>Extra mattress</span><span>{fmtR(q.mattressCents)}</span></div> : null}
                        <div className="ph-row ph-rowtot"><span>Amount paid out</span><span>{fmtR(q.rentalCents)}</span></div>
                        {q.depositCents ? <div className="ph-row ph-depo"><span>Refundable breakage deposit (not part of payout)</span><span>{fmtR(q.depositCents)}</span></div> : null}
                      </>)}
                    </div>
                  )}
                </section>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
