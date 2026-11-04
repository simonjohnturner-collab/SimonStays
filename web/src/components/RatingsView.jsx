import { useEffect, useState } from 'react';
import { api } from '../api.js';

const fmtDay = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const placeOf = (r) => [r.propertyName, r.unitName && `Unit ${r.unitName}`].filter(Boolean).join(' · ') || '—';

// A guest's rating, shown on requests and bookings. Hover for the categories.
export function GuestRatingChip({ rating }) {
  if (!rating) return <span className="rating-chip none">No guest rating yet</span>;
  const detail = rating.categories.map((c) => `${c.label}: ${c.average.toFixed(1)}`).join('\n');
  return <span className="rating-chip" title={detail}>★ {rating.average.toFixed(1)} guest rating ({rating.count})</span>;
}

function Summary({ title, rating }) {
  if (!rating) return null;
  return (
    <section className="sp-card rating-summary">
      <div className="rating-big">★ {rating.average.toFixed(1)}</div>
      <div><b>{title}</b><div className="muted small">{rating.count} rating{rating.count === 1 ? '' : 's'}</div></div>
      <dl>{rating.categories.map((c) => <div key={c.key}><dt>{c.label}</dt><dd>{c.average.toFixed(1)}</dd></div>)}</dl>
    </section>
  );
}

function StarPicker({ label, value, onChange }) {
  return (
    <div className="rate-row">
      <span>{label}</span>
      <span className="rate-stars" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n === 1 ? '' : 's'}`} className={value >= n ? 'on' : ''} onClick={() => onChange(n)}>★</button>
        ))}
      </span>
    </div>
  );
}

function RateGuest({ stay, categories, onDone }) {
  const [scores, setScores] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ready = categories.every((c) => scores[c.key]);
  async function save() {
    setBusy(true); setErr('');
    try { await api.rateGuest(stay.bookingId, scores); onDone(); }
    catch (e) { setErr((e.data && e.data.message) || e.message); setBusy(false); }
  }
  return (
    <section className="sp-card rate-card">
      <div className="rate-guest">
        <b>{stay.guestName || 'Guest'}</b>{stay.ref ? <span className="muted small"> · {stay.ref}</span> : null}
        <div className="muted small">{placeOf(stay)}, {fmtDay(stay.checkIn)} to {fmtDay(stay.checkOut)}</div>
        <GuestRatingChip rating={stay.guestRating} />
      </div>
      <div>
        {categories.map((c) => <StarPicker key={c.key} label={c.label} value={scores[c.key] || 0} onChange={(n) => setScores({ ...scores, [c.key]: n })} />)}
        {err && <div className="msg-warn">{err}</div>}
        <button type="button" disabled={!ready || busy} onClick={save}>{busy ? 'Saving…' : 'Save rating'}</button>
      </div>
    </section>
  );
}

export default function RatingsView() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.listRatings().then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <div className="ratings-view"><p className="small">{err}</p></div>;
  if (!data) return <div className="ratings-view"><p className="muted small">Loading…</p></div>;
  const catLine = (cats, scores) => cats.map((c) => `${c.label} ${scores[c.key]}`).join(' · ');
  return (
    <div className="ratings-view">
      <h3>Guests to rate</h3>
      {data.toRate.length === 0 && <p className="muted small">Nobody to rate right now. Guests with an email appear here after they check out, for 30 days.</p>}
      {data.toRate.map((s) => <RateGuest key={s.bookingId} stay={s} categories={data.guestCategories} onDone={load} />)}

      <h3>How guests rate you</h3>
      {!data.overall && <p className="muted small">No ratings yet. Guests are invited to rate their stay the day after they check out.</p>}
      <Summary title="Your rating as a host" rating={data.overall} />
      {data.properties.length > 1 && data.properties.map((p) => <Summary key={p.propertyId} title={p.name} rating={p.rating} />)}
      {data.received.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Stay</th><th>Guest</th><th>Scores</th><th className="num">Overall</th></tr></thead>
            <tbody>{data.received.map((r) => (
              <tr key={r.id}><td className="small">{placeOf(r)}<div className="muted">{fmtDay(r.checkIn)} to {fmtDay(r.checkOut)}</div></td><td className="small">{r.guestName || 'Guest'}</td><td className="small tx-wrap">{catLine(data.hostCategories, r.scores)}</td><td className="num">★ {r.average.toFixed(1)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {data.given.length > 0 && (
        <>
          <h3>Guests you’ve rated</h3>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Guest</th><th>Stay</th><th>Scores</th><th className="num">Overall</th></tr></thead>
              <tbody>{data.given.map((r) => (
                <tr key={r.id}><td className="small">{r.guestName || 'Guest'}<div className="muted">{r.guestEmail}</div></td><td className="small">{placeOf(r)}<div className="muted">{fmtDay(r.checkIn)} to {fmtDay(r.checkOut)}</div></td><td className="small tx-wrap">{catLine(data.guestCategories, r.scores)}</td><td className="num">★ {r.average.toFixed(1)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
