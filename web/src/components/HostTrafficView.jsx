import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Insights › Listing traffic: how a host's own listings do on simonstays.co.za.
// Shown in search results → opened → checkout started → booked, per day and per
// listing, and where those visitors came from. Counts only, no visitor details.
const num = (v) => Number(v || 0).toLocaleString('en-ZA');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days']];
const SHOP = 'https://simonstays.co.za';

function Tile({ label, value, sub }) {
  return <div className="mk-tile"><div className="mk-tile-label">{label}</div><div className="mk-tile-value">{value}</div>{sub && <div className="mk-tile-sub">{sub}</div>}</div>;
}

export default function HostTrafficView() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { setData(null); api.hostTraffic(days).then(setData).catch((e) => setErr(e.message)); }, [days]);

  const t = (data && data.totals) || {};
  const max = data ? Math.max(1, ...data.daily.map((d) => d.views)) : 1;
  return (
    <div className="ht-wrap">
      <div className="ht-head">
        <p className="muted small">How your listings are doing on simonstays.co.za: how often they showed up in searches, were opened, and turned into bookings. Your own visits while signed in aren’t counted.</p>
        <div className="ht-range">{RANGES.map(([d, l]) => <button key={d} className={days === d ? 'on' : 'secondary'} onClick={() => setDays(d)}>{l}</button>)}</div>
      </div>
      {err && <div className="msg err">{err}</div>}
      {!data ? <p className="muted small">Loading…</p> : data.empty && !data.listings.length ? <p className="muted">Add a listing first, then its traffic shows here.</p> : (
        <>
          <div className="mk-tiles">
            <Tile label="Seen in search" value={num(t.impressions)} sub="times your listings appeared in results" />
            <Tile label="Opened" value={num(t.views)} sub={`${num(t.viewers)} people · ${pct(t.views, t.impressions)} of times seen`} />
            <Tile label="Started checkout" value={num(t.checkouts)} sub={`${pct(t.checkouts, t.viewers)} of people who opened one`} />
            <Tile label="Booked or requested" value={num(t.bookings)} sub={t.enquiries ? `plus ${num(t.enquiries)} question${t.enquiries === 1 ? '' : 's'} to you` : 'on SimonStays'} />
          </div>

          <section className="tr-card">
            <h4>Listing opens per day</h4>
            {!data.daily.length ? <p className="muted small">No visits to your listings in this period yet.</p> : (
              <div className="tr-chart" role="img" aria-label="Listing opens per day">
                {data.daily.map((d) => (
                  <div key={d.day} className="tr-col" title={`${d.day}: opened ${d.views} times by ${d.viewers} people · seen in search ${d.impressions} times`}>
                    <div className="tr-bars"><div className="tr-bar vis" style={{ height: `${(d.views / max) * 100}%` }} /></div>
                    <span className="tr-day">{d.day.slice(8)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="tr-card">
            <h4>Your listings</h4>
            <div className="admin-table-wrap">
              <table className="tr-table">
                <thead><tr><th>Listing</th><th className="num">Seen in search</th><th className="num">Opened</th><th className="num">People</th><th className="num">Checkout</th><th className="num">Booked</th><th className="num">Open rate</th></tr></thead>
                <tbody>{data.listings.map((l) => (
                  <tr key={l.unitId}>
                    <td><a href={`${SHOP}/stays/${l.propertyId}/${l.unitId}`} target="_blank" rel="noreferrer">{l.name} ↗</a></td>
                    <td className="num">{num(l.impressions)}</td><td className="num">{num(l.views)}</td><td className="num">{num(l.viewers)}</td>
                    <td className="num">{num(l.checkouts)}</td><td className="num"><b>{num(l.bookings)}</b></td><td className="num">{pct(l.views, l.impressions)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p className="muted small">Open rate is how often people who saw a listing in search opened it. A low one usually means the cover photo or price needs work.</p>
          </section>

          <div className="ht-two">
            <section className="tr-card">
              <h4>Where they came from</h4>
              {!data.sources.length ? <p className="muted small">Nothing yet.</p> : <table className="tr-table"><tbody>{data.sources.map((r) => <tr key={r.key}><td>{r.key}</td><td className="num">{num(r.visitors)} people</td></tr>)}</tbody></table>}
            </section>
            <section className="tr-card">
              <h4>Device</h4>
              {!data.devices.length ? <p className="muted small">Nothing yet.</p> : <table className="tr-table"><tbody>{data.devices.map((r) => <tr key={r.key}><td style={{ textTransform: 'capitalize' }}>{r.key}</td><td className="num">{num(r.visitors)} people</td></tr>)}</tbody></table>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
