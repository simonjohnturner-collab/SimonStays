import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Pricing bubbles: similar units, from any host, grouped so that prices follow
// how full the group is. Each host adds their own units and sets their own
// rules; other hosts only ever see counts, never your units or prices. The
// changes apply to SimonStays (direct) bookings only, on top of your rate card.
const SUGGESTED = {
  active: true,
  surge: [{ occupancyPct: 70, increasePct: 5 }, { occupancyPct: 80, increasePct: 10 }, { occupancyPct: 90, increasePct: 20 }],
  drops: [{ withinDays: 3, vacancyPct: 80, decreasePct: 10 }],
};
const dayLabel = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });

export default function BubblesView() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  const [nw, setNw] = useState({ name: '', area: '' });
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setData(await api.listBubbles()); } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  }
  useEffect(() => { load(); }, []);

  async function run(fn, ok) {
    setBusy(true); setMsg(null);
    try { await fn(); await load(); if (ok) setMsg({ kind: 'ok', text: ok }); }
    catch (e) { setMsg({ kind: 'err', text: e.message }); }
    finally { setBusy(false); }
  }
  const create = () => {
    if (!nw.name.trim()) { setMsg({ kind: 'err', text: 'Give the bubble a name, e.g. Rosebank 2-bed.' }); return; }
    run(async () => { await api.createBubble(nw); setNw({ name: '', area: '' }); }, 'Bubble created. Add your units and set your rules below.');
  };

  if (!data) return <div className="bb-wrap"><p className="muted small">{msg ? msg.text : 'Loading…'}</p></div>;
  return (
    <div className="bb-wrap">
      <p className="muted small bb-intro">
        Group similar units, yours and other hosts’, into a bubble. Your SimonStays prices then follow how full the
        bubble is, using <b>your own rules</b>. Other hosts see how many units are in a bubble, never which of yours or what you charge.
        Changes apply to direct bookings on simonstays.co.za only, on top of your rate card.
      </p>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

      <section className="sp-card bb-new">
        <b>New bubble</b>
        <div className="bb-new-row">
          <input placeholder="Name, e.g. Rosebank 2-bed" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          <input placeholder="Area, e.g. Rosebank" value={nw.area} onChange={(e) => setNw({ ...nw, area: e.target.value })} />
          <button disabled={busy} onClick={create}>➕ Create</button>
        </div>
      </section>

      {data.bubbles.length === 0 && <p className="muted">No bubbles yet. Create the first one above.</p>}
      {data.bubbles.map((b) => <Bubble key={b.id} b={b} units={data.units} busy={busy} run={run} />)}
    </div>
  );
}

function Bubble({ b, units, busy, run }) {
  const [rule, setRule] = useState(b.rule || null);
  const [dirty, setDirty] = useState(false);
  const [adding, setAdding] = useState('');
  useEffect(() => { setRule(b.rule || null); setDirty(false); }, [b.rule]);

  const free = units.filter((u) => !u.bubbleId);
  const elsewhere = units.filter((u) => u.bubbleId && u.bubbleId !== b.id);
  const edit = (patch) => { setRule({ ...(rule || SUGGESTED), ...patch }); setDirty(true); };
  const setRow = (key, i, field, v) => edit({ [key]: rule[key].map((r, j) => (j === i ? { ...r, [field]: v } : r)) });
  const addRow = (key, row) => edit({ [key]: [...(rule[key] || []), row] });
  const delRow = (key, i) => edit({ [key]: rule[key].filter((_, j) => j !== i) });

  return (
    <section className="sp-card bb-card">
      <div className="bb-head">
        <div>
          <h3>{b.name}</h3>
          <span className="muted small">{[b.area, `${b.unitCount} unit${b.unitCount === 1 ? '' : 's'}`, `${b.hostCount} host${b.hostCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}{b.createdByMe ? ' · created by you' : ''}</span>
        </div>
        {b.createdByMe && <button className="mini danger" disabled={busy} onClick={() => { if (window.confirm(`Delete the bubble “${b.name}”? Your units leave it and your rules for it are removed.`)) run(() => api.deleteBubble(b.id), 'Bubble deleted.'); }}>Delete</button>}
      </div>

      <div className="bb-strip">
        {b.preview.map((d) => (
          <div key={d.date} className={`bb-day${d.adjustPct > 0 ? ' up' : d.adjustPct < 0 ? ' down' : ''}`}
            title={`${dayLabel(d.date)}: ${d.booked} on units + ${d.floating} floating = ${Math.min(d.units, d.booked + d.floating)} of ${d.units} (${d.occupancyPct}%)${d.skipped ? `. ${d.skipped} untagged floating not counted` : ''}`}>
            <small>{dayLabel(d.date)}</small>
            <b>{Math.round(d.occupancyPct)}%</b>
            <em>{Math.min(d.units, d.booked + d.floating)}/{d.units}{d.skipped ? ' ⚠' : ''}</em>
            <span>{d.adjustPct ? `${d.adjustPct > 0 ? '+' : ''}${d.adjustPct}%` : '·'}</span>
          </div>
        ))}
      </div>
      <p className="muted small bb-strip-note">Next 14 nights: how full the bubble is (units booked, including floating bookings), and your price change{b.myUnits.length ? '' : ' (once you add units)'}. Hover a night for the details.</p>
      {b.preview.some((d) => d.skipped) && (
        <div className="msg-warn">⚠ Some floating bookings aren’t counted ({b.preview.filter((d) => d.skipped).map((d) => dayLabel(d.date)).join(', ')}). They have no group, and you have units in more than one bubble, so we can’t tell which bubble they belong to. Open each one and set <b>Show in group</b> to the group these units are in, or allocate it to a unit, and it will count.</div>
      )}

      <h4>Your units in this bubble</h4>
      <div className="bb-units">
        {b.myUnits.length === 0 && <span className="muted small">None yet.</span>}
        {b.myUnits.map((u) => (
          <span key={u.unitId} className="bb-chip">{u.label}
            <button type="button" title="Take out of this bubble" disabled={busy} onClick={() => run(() => api.removeBubbleUnit(b.id, u.unitId))}>×</button>
          </span>
        ))}
      </div>
      <div className="bb-add">
        <select value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">Add one of your units…</option>
          {free.map((u) => <option key={u.id} value={u.id}>{u.label}{u.bedrooms ? ` · ${u.bedrooms} bed` : ''}</option>)}
          {elsewhere.length > 0 && <optgroup label="In another bubble">{elsewhere.map((u) => <option key={u.id} value={u.id} disabled>{u.label} ({u.bubbleName})</option>)}</optgroup>}
        </select>
        <button className="mini" disabled={busy || !adding} onClick={() => run(async () => { await api.addBubbleUnit(b.id, adding); setAdding(''); })}>Add</button>
      </div>
      {b.otherUnits > 0 && <p className="muted small">Plus {b.otherUnits} unit{b.otherUnits === 1 ? '' : 's'} from other hosts.</p>}

      <h4>Your rules</h4>
      {!rule ? (
        <div className="bb-norule">
          <span className="muted small">No rules yet, so your prices don’t change.</span>
          <button className="mini" onClick={() => edit({})}>Start with suggested rules</button>
        </div>
      ) : (
        <div className="bb-rules">
          <label className="chk"><input type="checkbox" checked={rule.active} onChange={(e) => edit({ active: e.target.checked })} /> Rules on</label>

          <div className="bb-rule-title">📈 Price surge when the bubble fills up</div>
          {(rule.surge || []).map((r, i) => (
            <div key={i} className="bb-rule-row">
              <span>When</span><input type="number" min="1" max="100" value={r.occupancyPct} onChange={(e) => setRow('surge', i, 'occupancyPct', e.target.value)} /><span>% booked, raise by</span>
              <input type="number" min="0.5" max="200" step="0.5" value={r.increasePct} onChange={(e) => setRow('surge', i, 'increasePct', e.target.value)} /><span>%</span>
              <button type="button" className="del sm" onClick={() => delRow('surge', i)}>×</button>
            </div>
          ))}
          <button type="button" className="mini" onClick={() => addRow('surge', { occupancyPct: 95, increasePct: 25 })}>+ Add a step</button>

          <div className="bb-rule-title">🏷️ Last-minute price drop when it’s empty</div>
          {(rule.drops || []).map((r, i) => (
            <div key={i} className="bb-rule-row">
              <span>Within</span><input type="number" min="0" max="365" value={r.withinDays} onChange={(e) => setRow('drops', i, 'withinDays', e.target.value)} /><span>days, if</span>
              <input type="number" min="1" max="100" value={r.vacancyPct} onChange={(e) => setRow('drops', i, 'vacancyPct', e.target.value)} /><span>% empty, drop by</span>
              <input type="number" min="0.5" max="90" step="0.5" value={r.decreasePct} onChange={(e) => setRow('drops', i, 'decreasePct', e.target.value)} /><span>%</span>
              <button type="button" className="del sm" onClick={() => delRow('drops', i)}>×</button>
            </div>
          ))}
          <button type="button" className="mini" onClick={() => addRow('drops', { withinDays: 7, vacancyPct: 70, decreasePct: 5 })}>+ Add a drop</button>

          <p className="muted small">The highest surge step reached applies. A drop only applies when no surge does; the biggest drop that fits wins. Nights you’ve priced by hand aren’t changed.</p>
          <button disabled={busy || !dirty} onClick={() => run(() => api.saveBubbleRules(b.id, rule), 'Rules saved.')}>{dirty ? 'Save rules' : 'Saved ✓'}</button>
        </div>
      )}
    </section>
  );
}
