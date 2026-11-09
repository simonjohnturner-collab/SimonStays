import { useEffect, useState } from 'react';
import { apiBaseUrl, getToken } from '../api.js';

// Platform admin › Traffic: who's looking at the site and what they do.
// First-party data from the tracker on simonstays.co.za (GET /admin/traffic).
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const num = (v) => Number(v || 0).toLocaleString('en-ZA');
const RANGES = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days']];

function Tile({ label, value, sub }) {
  return <div className="mk-tile"><div className="mk-tile-label">{label}</div><div className="mk-tile-value">{value}</div>{sub && <div className="mk-tile-sub">{sub}</div>}</div>;
}

// Visitors per day as bars; page views as the faint bar behind.
function DailyChart({ daily }) {
  if (!daily.length) return <p className="muted small">No visits in this period yet.</p>;
  const max = Math.max(1, ...daily.map((d) => d.pageviews));
  return (
    <div className="tr-chart" role="img" aria-label="Visitors and page views per day">
      {daily.map((d) => (
        <div key={d.day} className="tr-col" title={`${d.day}: ${d.visitors} visitors · ${d.pageviews} page views · ${d.listingViews} listing views`}>
          <div className="tr-bars">
            <div className="tr-bar pv" style={{ height: `${(d.pageviews / max) * 100}%` }} />
            <div className="tr-bar vis" style={{ height: `${(d.visitors / max) * 100}%` }} />
          </div>
          <span className="tr-day">{d.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

function Funnel({ f }) {
  const steps = [['Visited the site', f.visited], ['Searched', f.searched], ['Opened a listing', f.viewed], ['Started checkout', f.checkout], ['Booked or requested', f.booked]];
  return (
    <div className="tr-funnel">
      {steps.map(([label, v], i) => (
        <div key={label} className="tr-step">
          <div className="tr-step-bar" style={{ width: `${f.visited ? Math.max(2, (v / f.visited) * 100) : 0}%` }} />
          <span className="tr-step-label">{label}</span>
          <span className="tr-step-val">{num(v)} <span className="muted">{i ? pct(v, steps[i - 1][1]) + ' of previous' : ''}</span></span>
        </div>
      ))}
    </div>
  );
}

function TopList({ title, rows, keyLabel, empty }) {
  return (
    <section className="tr-card">
      <h4>{title}</h4>
      {!rows.length ? <p className="muted small">{empty}</p> : (
        <table className="tr-table"><thead><tr><th>{keyLabel}</th><th className="num">Times</th><th className="num">People</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.key}><td>{r.key}</td><td className="num">{num(r.count)}</td><td className="num">{num(r.visitors)}</td></tr>)}</tbody></table>
      )}
    </section>
  );
}

export default function TrafficView() {
  const [days, setDays] = useState(30);
  const [hosts, setHosts] = useState(false);
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true; setErr('');
    fetch(`${apiBaseUrl().replace(/\/$/, '')}/admin/traffic?days=${days}${hosts ? '&hosts=1' : ''}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then((j) => { if (live) setD(j); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [days, hosts]);

  const t = (d && d.totals) || {};
  return (
    <div className="tr-wrap">
      <div className="tr-head">
        <div className="tr-ranges">{RANGES.map(([v, l]) => <button key={v} className={days === v ? 'on' : ''} onClick={() => setDays(v)}>{l}</button>)}</div>
        <label className="tr-hosts"><input type="checkbox" checked={hosts} onChange={(e) => setHosts(e.target.checked)} /> Include hosts’ own visits</label>
        {d && <span className="tr-live"><i />{num(d.liveVisitors)} on the site now</span>}
      </div>
      {err && <div className="msg-warn">{err}</div>}
      {!d ? <p className="muted small">Loading…</p> : d.empty ? <p className="muted">No visits recorded yet. Data starts collecting from the moment this was switched on.</p> : (
        <>
          <div className="mk-tiles">
            <Tile label="Visitors" value={num(t.visitors)} sub={`${num(d.returningVisitors)} came back more than once`} />
            <Tile label="Visits (sessions)" value={num(t.sessions)} sub={`${num(t.pageviews)} page views`} />
            <Tile label="Listing views" value={num(t.listing_views)} sub={`${num(t.impressions)} listings seen in results · ${pct(t.listing_views, t.impressions)} opened`} />
            <Tile label="Bookings & requests" value={num(t.booked + t.requests)} sub={`${num(t.checkouts)} checkouts started · ${num(t.enquiries)} questions sent · ${num(t.signups)} sign-ups`} />
          </div>

          <section className="tr-card"><h4>Visitors per day <span className="muted small">(dark: visitors · light: page views)</span></h4><DailyChart daily={d.daily} /></section>

          <div className="tr-grid">
            <section className="tr-card"><h4>From looking to booking</h4><Funnel f={d.funnel} /><p className="muted small">People, not clicks: each visitor counts once at each step.</p></section>
            <TopList title="Where visitors come from" rows={d.sources} keyLabel="Source" empty="No visits yet." />
          </div>

          <section className="tr-card">
            <h4>How each listing performs</h4>
            {!d.listings.length ? <p className="muted small">No listings seen yet.</p> : (
              <div className="tr-scroll"><table className="tr-table">
                <thead><tr><th>Listing</th><th className="num">Seen in results</th><th className="num">Opened</th><th className="num">Open rate</th><th className="num">Checkouts</th><th className="num">Booked / requested</th></tr></thead>
                <tbody>{d.listings.map((l) => (
                  <tr key={l.unitId}><td>{l.name}</td><td className="num">{num(l.impressions)}</td><td className="num">{num(l.views)}</td><td className="num">{pct(l.views, l.impressions)}</td><td className="num">{num(l.checkouts)}</td><td className="num">{num(l.bookings)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
            <p className="muted small">A low open rate means people see the listing but don’t click it: try a better cover photo or price. Many opens but few checkouts usually points to the price, dates or description.</p>
          </section>

          <div className="tr-grid">
            <TopList title="What people click" rows={d.clicks} keyLabel="Button or link" empty="No clicks yet." />
            <TopList title="What people search for" rows={d.searches} keyLabel="Area typed" empty="No searches yet." />
          </div>
          <div className="tr-grid">
            <TopList title="Pages visited" rows={d.pages} keyLabel="Page" empty="No page views yet." />
            <TopList title="Devices" rows={d.devices} keyLabel="Device" empty="No visits yet." />
          </div>
          <p className="muted small">Counted on simonstays.co.za without cookies or IP addresses. Search engine bots are left out{hosts ? '' : ', and so are hosts browsing while signed in'}.</p>
        </>
      )}
    </div>
  );
}
