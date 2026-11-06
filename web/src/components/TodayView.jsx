import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { today, addDays, ymd } from '../dates.js';
import { navigate } from '../router.js';

// Hosting › Today: the day at a glance. Who leaves and arrives, what's waiting
// (reports, guest messages, Ask Simon questions) and money still owed — the
// things that used to be spread over the bell, the board and the forms list.
const rand = (c) => 'R' + (Math.round(c) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayKey = (d) => ymd(new Date(d));
const shortDay = (d) => new Date(d).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
const typeLabel = (t) => (t === 'damage' ? 'Damage report' : t === 'repair' ? 'Repair' : 'Clean');

export default function TodayView({ properties, teachCount = 0, onOpenBooking }) {
  const [bookings, setBookings] = useState(null); // [{ ...booking, unit, unitLabel }]
  const [reports, setReports] = useState([]);
  const [unread, setUnread] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    const units = properties.flatMap((p) => p.units.map((u) => ({ ...u, propertyName: p.name, label: `${p.name} · ${u.name}` })));
    const from = ymd(addDays(today(), -30)), to = ymd(addDays(today(), 15)); // -30: catch long stays still in the house
    Promise.all(units.map((u) => api.unitBookings(u.id, from, to).then((r) => (r.bookings || []).map((b) => ({ ...b, unit: u, unitLabel: u.label })))))
      .then((lists) => { if (live) setBookings(lists.flat().filter((b) => b.status !== 'cancelled')); })
      .catch(() => { if (live) setErr('Couldn’t load bookings. Check your connection and refresh.'); });
    api.listFormSubmissions('?status=new&limit=30').then((r) => live && setReports(r.submissions || [])).catch(() => {});
    api.messageUnread().then((r) => live && setUnread(r.threads || [])).catch(() => {});
    return () => { live = false; };
  }, [properties]);

  const t0 = ymd(today()), t7 = ymd(addDays(today(), 7));
  const list = bookings || [];
  const real = list.filter((b) => b.status !== 'enquiry' && b.status !== 'pending');
  const out = real.filter((b) => dayKey(b.checkOut) === t0);
  const inn = real.filter((b) => dayKey(b.checkIn) === t0);
  const staying = real.filter((b) => dayKey(b.checkIn) <= t0 && dayKey(b.checkOut) > t0);
  const coming = real.filter((b) => dayKey(b.checkIn) > t0 && dayKey(b.checkIn) <= t7).sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));
  const owing = real.filter((b) => (b.amountOwingCents || 0) > 0 && dayKey(b.checkOut) >= t0 && dayKey(b.checkIn) <= ymd(addDays(today(), 14)))
    .sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));
  const totalUnits = properties.reduce((n, p) => n + p.units.length, 0);
  const attention = reports.length + unread.length + teachCount + owing.length;

  const row = (b, extra) => (
    <button key={b.id} className="today-row" onClick={() => onOpenBooking(b, b.unit)}>
      <span className="today-unit">{b.unitLabel}</span>
      <span className="today-guest">{b.guestName || 'Guest'}{b.guests ? ` · ${b.guests} guests` : ''}</span>
      <span className="today-extra">{extra}</span>
    </button>
  );

  return (
    <div className="today">
      <div className="today-head">
        <h1>{new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' })}</h1>
        <p className="muted">
          {bookings ? `${staying.length} of ${totalUnits} units occupied tonight · ${out.length} checkout${out.length === 1 ? '' : 's'} · ${inn.length} check-in${inn.length === 1 ? '' : 's'}` : 'Loading…'}
          {attention > 0 && <> · <b className="today-attn">{attention} need{attention === 1 ? 's' : ''} you</b></>}
        </p>
      </div>
      {err && <div className="banner sync-failed">{err}</div>}

      <div className="today-grid">
        <section className="today-card">
          <h2>Checking out today <span className="count">{out.length}</span></h2>
          {out.length ? out.map((b) => row(b, b.cleaner ? `Clean: ${b.cleaner}` : <span className="tag warn">No cleaner set</span>)) : <p className="muted small">No checkouts today.</p>}
        </section>
        <section className="today-card">
          <h2>Checking in today <span className="count">{inn.length}</span></h2>
          {inn.length ? inn.map((b) => row(b, (b.amountOwingCents || 0) > 0 ? <span className="tag warn">{rand(b.amountOwingCents)} owing</span> : <span className="tag ok">Paid</span>)) : <p className="muted small">No check-ins today.</p>}
        </section>

        <section className="today-card">
          <h2>Needs you</h2>
          {attention === 0 && <p className="muted small">Nothing waiting. 🎉</p>}
          {reports.map((r) => (
            <button key={r.id} className="today-row" onClick={() => navigate(`/reports/${r.id}`)}>
              <span className="today-unit">{typeLabel(r.type)}</span>
              <span className="today-guest">{[r.propertyName || r.property?.name, r.unitName || r.unit?.name].filter(Boolean).join(' · ') || 'Report'}{r.submitterName ? ` · ${r.submitterName}` : ''}</span>
              <span className="today-extra"><span className="tag">New report</span></span>
            </button>
          ))}
          {unread.map((m) => (
            <button key={m.bookingId} className="today-row" onClick={() => navigate(`/inbox?booking=${encodeURIComponent(m.bookingId)}`)}>
              <span className="today-unit">{m.guestName || 'Guest'}</span>
              <span className="today-guest">{m.body}</span>
              <span className="today-extra"><span className="tag">{m.enquiry ? 'Enquiry' : 'Message'}</span></span>
            </button>
          ))}
          {teachCount > 0 && (
            <button className="today-row" onClick={() => navigate('/inbox/teach')}>
              <span className="today-unit">Ask Simon</span>
              <span className="today-guest">{teachCount} guest question{teachCount === 1 ? '' : 's'} waiting for your answer</span>
              <span className="today-extra"><span className="tag">Answer</span></span>
            </button>
          )}
          {owing.map((b) => row(b, <span className="tag warn">{rand(b.amountOwingCents)} owing · in {shortDay(b.checkIn)}</span>))}
        </section>

        <section className="today-card">
          <h2>Arriving this week <span className="count">{coming.length}</span></h2>
          {coming.length ? coming.map((b) => row(b, shortDay(b.checkIn))) : <p className="muted small">No arrivals in the next 7 days.</p>}
        </section>
      </div>
    </div>
  );
}
