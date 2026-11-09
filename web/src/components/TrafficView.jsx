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


const when = (d) => new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const waLink = (phone) => { const d = String(phone || '').replace(/\D/g, ''); if (!d) return null; return `https://wa.me/${d.startsWith('0') ? '27' + d.slice(1) : d}`; };
const EVENT_TEXT = {
  pageview: (e) => `Opened ${e.path === '/' ? 'the home page' : e.path}`,
  search: (e) => `Searched “${e.label || 'any area'}”`,
  impression: (e) => `Saw ${e.place || 'a listing'} in the results`,
  view_listing: (e) => `Opened ${e.place || e.label || 'a listing'}`,
  click: (e) => `Clicked “${e.label}”`,
  start_checkout: (e) => `Started checkout${e.place ? ` for ${e.place}` : ''}`,
  booking_placed: (e) => `Placed a booking${e.place ? ` for ${e.place}` : ''}`,
  booked: () => 'Paid: booking confirmed 🎉',
  request_sent: (e) => `Sent a booking request${e.place ? ` for ${e.place}` : ''}`,
  enquiry_sent: (e) => `Asked the host a question${e.place ? ` about ${e.place}` : ''}`,
  signup: () => 'Created an account', signin: () => 'Signed in',
};

function Journey({ visitor, onClose }) {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    fetch(`${apiBaseUrl().replace(/\/$/, '')}/admin/traffic/visitors/${encodeURIComponent(visitor.id)}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => r.json()).then((d) => setEvents(d.events || [])).catch(() => setEvents([]));
  }, [visitor.id]);
  // Impressions are noisy in a timeline: fold runs of them into one line.
  const lines = [];
  (events || []).forEach((e, i) => {
    const prev = events[i - 1];
    if (prev && prev.session !== e.session) lines.push({ gap: true, at: e.at });
    if (e.type === 'impression' && lines.length && lines[lines.length - 1].type === 'impression') { lines[lines.length - 1].n += 1; return; }
    lines.push({ ...e, n: 1 });
  });
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal tr-journey" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{visitor.person ? visitor.person.name || visitor.person.email : 'Anonymous visitor'}</h3><button className="x" onClick={onClose}>×</button></div>
        <p className="muted small">{[visitor.device, visitor.source ? `from ${visitor.source}` : 'came direct', `${visitor.sessions} visit${visitor.sessions === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</p>
        {!events ? <p className="muted small">Loading…</p> : (
          <ol className="tr-timeline">{lines.map((l, i) => (l.gap
            ? <li key={i} className="tr-gap">New visit · {when(l.at)}</li>
            : <li key={i}><span className="tr-t">{new Date(l.at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</span>{l.type === 'impression' && l.n > 1 ? `Scrolled past ${l.n} listings` : (EVENT_TEXT[l.type] || (() => l.type))(l)}</li>))}
          </ol>
        )}
      </div>
    </div>
  );
}

function FollowUps({ items }) {
  if (!items.length) return <p className="muted small">Nobody to follow up right now. People appear here when they start a booking without paying, or when someone who’s signed in looks at listings or starts checkout without booking.</p>;
  return (
    <div className="tr-follow">{items.map((f, i) => (
      <div key={i} className={`tr-person ${f.kind}`}>
        <div className="tr-person-main"><b>{f.name || f.email || 'Guest'}</b><span className="muted small">{f.why}{f.place ? ` · ${f.place}` : ''}{f.dates ? ` · ${f.dates}` : ''}{f.amountCents ? ` · R${Math.round(f.amountCents / 100).toLocaleString('en-ZA')}` : ''} · {when(f.at)}</span></div>
        <div className="tr-person-actions">
          {waLink(f.phone) && <a className="tr-btn wa" href={waLink(f.phone)} target="_blank" rel="noreferrer">WhatsApp {f.phone}</a>}
          {f.email && <a className="tr-btn" href={`mailto:${f.email}`}>{f.email}</a>}
        </div>
      </div>
    ))}</div>
  );
}

function Visitors({ list, onOpen }) {
  if (!list.length) return <p className="muted small">No visitors in this period yet.</p>;
  return (
    <div className="tr-scroll"><table className="tr-table tr-visitors">
      <thead><tr><th>Who</th><th>Last seen</th><th>From</th><th>Got as far as</th><th>Listings opened</th><th></th></tr></thead>
      <tbody>{list.map((v) => (
        <tr key={v.id}>
          <td>{v.person ? <><b>{v.person.name || v.person.email}</b>{v.person.phone && <div className="muted small">{v.person.phone}</div>}</> : <span className="muted">Anonymous · {v.device || 'device?'}</span>}</td>
          <td className="small">{when(v.last)}{v.sessions > 1 && <div className="muted">{v.sessions} visits</div>}</td>
          <td className="small">{v.source || 'Direct'}</td>
          <td className="small"><span className={`tr-step-pill s-${v.step.split(' ')[0].toLowerCase()}`}>{v.step}</span></td>
          <td className="small">{v.listings.join(', ') || '—'}</td>
          <td><button className="mini" onClick={() => onOpen(v)}>See journey</button></td>
        </tr>
      ))}</tbody>
    </table></div>
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

  const [people, setPeople] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`${apiBaseUrl().replace(/\/$/, '')}/admin/traffic/visitors?days=${Math.max(days, 7)}${hosts ? '&hosts=1' : ''}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => r.json()).then((j) => { if (live) setPeople(j); }).catch(() => {});
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

          <section className="tr-card tr-follow-card"><h4>📞 People to follow up</h4>{!people ? <p className="muted small">Loading…</p> : <FollowUps items={people.followUps || []} />}</section>

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
          <section className="tr-card"><h4>Recent visitors <span className="muted small">(named once they sign in or book; their earlier visits from the same browser are linked too)</span></h4>{!people ? <p className="muted small">Loading…</p> : <Visitors list={people.visitors || []} onOpen={setOpen} />}</section>
          {open && <Journey visitor={open} onClose={() => setOpen(null)} />}
          <p className="muted small">Counted on simonstays.co.za without cookies or IP addresses. Search engine bots are left out{hosts ? '' : ', and so are hosts browsing while signed in'}.</p>
        </>
      )}
    </div>
  );
}
