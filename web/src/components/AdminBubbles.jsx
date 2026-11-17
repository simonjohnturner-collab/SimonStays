import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Platform admin › Bubbles: every pricing bubble, its listings and hosts, each
// host's rules, and the next 14 nights' occupancy.
const day = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
const ruleText = (r) => [
  ...(r.surge || []).map((s) => `${s.occupancyPct}% booked → +${s.increasePct}%`),
  ...(r.drops || []).map((d) => `within ${d.withinDays}d, ${d.vacancyPct}% empty → −${d.decreasePct}%`),
].join(' · ') || 'No steps';

export default function AdminBubbles() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.adminBubbles().then(setData).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="msg err">{err}</div>;
  if (!data) return <p className="muted small">Loading…</p>;
  if (!data.bubbles.length) return <p className="muted">No pricing bubbles yet.</p>;
  return (
    <div className="ab-list">
      {data.bubbles.map((b) => (
        <section key={b.id} className="sp-card">
          <div className="bb-head">
            <div>
              <h3 style={{ margin: 0 }}>{b.name}</h3>
              <span className="muted small">{[b.area, `${b.listings.length} listing${b.listings.length === 1 ? '' : 's'}`, `created by ${b.createdBy}`].filter(Boolean).join(' · ')}</span>
            </div>
          </div>
          <div className="bb-strip">
            {b.preview.map((d) => (
              <div key={d.date} className="bb-day" title={`${d.booked} on units + ${d.floating} floating of ${d.units}${d.skipped ? ` · ${d.skipped} untagged floating not counted` : ''}`}>
                <small>{day(d.date)}</small><b>{Math.round(d.pct)}%</b><em>{Math.min(d.units, d.booked + d.floating)}/{d.units}{d.skipped ? ' ⚠' : ''}</em>
              </div>
            ))}
          </div>
          <table className="tr-table" style={{ marginTop: 10 }}>
            <thead><tr><th>Listing</th><th>Host</th><th className="num">Beds</th><th className="num">Sleeps</th></tr></thead>
            <tbody>{b.listings.map((l) => (
              <tr key={l.unitId}><td><a href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a></td><td>{l.hostName}</td><td className="num">{l.bedrooms ?? '—'}</td><td className="num">{l.sleeps ?? '—'}</td></tr>
            ))}</tbody>
          </table>
          <h4 style={{ margin: '12px 0 4px' }}>Rules</h4>
          {!b.rules.length ? <p className="muted small">No host has set rules yet.</p> : b.rules.map((r, i) => (
            <p key={i} className="small" style={{ margin: '2px 0' }}><b>{r.hostName}</b>{r.active ? '' : ' (off)'}: <span className="muted">{ruleText(r)}</span></p>
          ))}
        </section>
      ))}
    </div>
  );
}
