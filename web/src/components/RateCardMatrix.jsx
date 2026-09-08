import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { centsToRand, randToCents, fmtR } from '../money.js';

const num = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
// Computed values (cents) — first night bundles one clean; week/month per Simon's formula.
const cFirst = (v) => randToCents(v.nAdd) + randToCents(v.cleaning);
const cWeekly = (v) => Math.round((7 * randToCents(v.nAdd) + randToCents(v.cleaning)) * (1 - num(v.weekly) / 100));
const cMonthly = (v) => Math.round((30.25 * randToCents(v.nAdd) + randToCents(v.cleaning)) * (1 - num(v.monthly) / 100));

// One sheet: pricing categories down the left, pricing GROUPS across the top,
// plus a unit→group assignment section. Units in a group share its prices.
const ROWS = [
  { section: 'Nightly rate' },
  { key: 'nAdd', label: 'Nightly rate (per night)', type: 'money' },
  { key: 'weekendNight', label: 'Weekend rate (Fri/Sat) — optional', type: 'money' },
  { key: 'cleaning', label: 'Cleaning per clean', type: 'money' },
  { key: 'firstNight', label: 'First night (nightly + clean)', type: 'calc', calc: cFirst },
  { section: 'Discounts, deposit & fees' },
  { key: 'weekly', label: 'Weekly discount % (7 nights)', type: 'pctcalc', calc: cWeekly },
  { key: 'monthly', label: 'Monthly discount % (~30.25 nights)', type: 'pctcalc', calc: cMonthly },
  { key: 'breakage', label: 'Breakage deposit (refundable)', type: 'money' },
  { key: 'early', label: 'Early check-in', type: 'money' },
  { key: 'late', label: 'Late checkout', type: 'money' },
  { key: 'mattress', label: 'Extra mattress', type: 'money' },
  { section: 'Seasonal flexes — % increase over a date range (recurs yearly)' },
  { key: 'f1pct', label: 'Flex 1 · increase %', type: 'pct' }, { key: 'f1s', label: 'Flex 1 · start', type: 'date' }, { key: 'f1e', label: 'Flex 1 · end', type: 'date' },
  { key: 'f2pct', label: 'Flex 2 · increase %', type: 'pct' }, { key: 'f2s', label: 'Flex 2 · start', type: 'date' }, { key: 'f2e', label: 'Flex 2 · end', type: 'date' },
  { key: 'f3pct', label: 'Flex 3 · increase %', type: 'pct' }, { key: 'f3s', label: 'Flex 3 · start', type: 'date' }, { key: 'f3e', label: 'Flex 3 · end', type: 'date' },
  { key: 'f4pct', label: 'Flex 4 · increase %', type: 'pct' }, { key: 'f4s', label: 'Flex 4 · start', type: 'date' }, { key: 'f4e', label: 'Flex 4 · end', type: 'date' },
];

const r = (c) => (c == null ? '' : String(centsToRand(c)));

function toValues(g) {
  const fx = Array.isArray(g.flexes) ? g.flexes : [];
  const f = (i, k) => (fx[i] ? (fx[i][k] ?? '') : '');
  return {
    nAdd: r(g.additionalNightCents), weekendNight: r(g.weekendNightCents),
    weekly: g.weeklyDiscountPercent || '', monthly: g.monthlyDiscountPercent || '',
    breakage: r(g.breakageDepositCents), cleaning: r(g.cleaningCents), early: r(g.earlyCheckInCents), late: r(g.lateCheckOutCents), mattress: r(g.mattressCents),
    f1pct: f(0, 'percent'), f1s: f(0, 'start'), f1e: f(0, 'end'),
    f2pct: f(1, 'percent'), f2s: f(1, 'start'), f2e: f(1, 'end'),
    f3pct: f(2, 'percent'), f3s: f(2, 'start'), f3e: f(2, 'end'),
    f4pct: f(3, 'percent'), f4s: f(3, 'start'), f4e: f(3, 'end'),
  };
}

function toPayload(name, v) {
  const flexes = [];
  const addF = (pct, s, e) => { if (num(pct) > 0 && v[s] && v[e]) flexes.push({ percent: num(pct), start: v[s], end: v[e] }); };
  addF(v.f1pct, 'f1s', 'f1e'); addF(v.f2pct, 'f2s', 'f2e'); addF(v.f3pct, 'f3s', 'f3e'); addF(v.f4pct, 'f4s', 'f4e');
  return {
    name,
    additionalNightCents: randToCents(v.nAdd),
    weekendNightCents: v.weekendNight === '' || v.weekendNight == null ? null : randToCents(v.weekendNight),
    firstNightCents: cFirst(v), // computed: nightly + one clean (bundled)
    weeklyDiscountPercent: num(v.weekly), monthlyDiscountPercent: num(v.monthly),
    breakageDepositCents: randToCents(v.breakage), cleaningCents: randToCents(v.cleaning),
    earlyCheckInCents: randToCents(v.early), lateCheckOutCents: randToCents(v.late), mattressCents: randToCents(v.mattress),
    flexes,
  };
}

export default function RateCardMatrix({ onClose }) {
  const [cols, setCols] = useState(null);
  const [properties, setProperties] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const [g, pr] = await Promise.all([api.listGroups(), api.listProperties()]);
    setCols(g.groups.map((x) => ({ id: x.id, name: x.name, v: toValues(x) })));
    setProperties(pr.properties);
  }
  useEffect(() => { load(); }, []);

  const groupCount = (gid) => properties.reduce((n, p) => n + p.units.filter((u) => u.pricingGroupId === gid).length, 0);
  const setCell = (ci, key, val) => setCols((p) => p.map((c, i) => (i === ci ? { ...c, v: { ...c.v, [key]: val } } : c)));
  const setName = (ci, val) => setCols((p) => p.map((c, i) => (i === ci ? { ...c, name: val } : c)));
  const fillRow = (key) => setCols((p) => (p.length ? p.map((c) => ({ ...c, v: { ...c.v, [key]: p[0].v[key] } })) : p));

  async function newGroup() {
    const name = window.prompt('Group name (e.g. Firenza, or Studios)');
    if (!name) return;
    const { group } = await api.createGroup(name.trim());
    setCols([...cols, { id: group.id, name: group.name, v: toValues(group) }]); // append, keep edits
  }
  async function removeGroup(ci) {
    const c = cols[ci];
    if (!window.confirm(`Delete group “${c.name}”? Units in it become unassigned.`)) return;
    await api.deleteGroup(c.id);
    setCols(cols.filter((_, i) => i !== ci));
    const pr = await api.listProperties(); setProperties(pr.properties);
  }
  async function assign(unitId, groupId) {
    await api.assignUnitGroup(unitId, groupId || null);
    const pr = await api.listProperties(); setProperties(pr.properties); // refresh assignments only, keep price edits
  }
  async function saveAll() {
    setBusy(true); setMsg('');
    try { await Promise.all(cols.map((c) => api.updateGroup(c.id, toPayload(c.name, c.v)))); setMsg('Saved.'); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Pricing groups</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={newGroup}>＋ New group</button>
        <button className="ghost" onClick={saveAll} disabled={busy || !cols}>{busy ? 'Saving…' : '💾 Save all'}</button>
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="matrix-wrap">
        {!cols ? <p className="muted small">Loading…</p> : cols.length === 0 ? (
          <p className="muted small">No pricing groups yet. Create one with <b>＋ New group</b>, then assign units below.</p>
        ) : (
          <table className="matrix">
            <thead>
              <tr>
                <th className="rowhead corner">Category</th>
                {cols.map((c, ci) => (
                  <th key={c.id} className="grouphead">
                    <input className="gname" value={c.name} onChange={(e) => setName(ci, e.target.value)} />
                    <div className="gsub">{groupCount(c.id)} unit{groupCount(c.id) === 1 ? '' : 's'} <button className="del sm gdel" title="Delete group" onClick={() => removeGroup(ci)}>×</button></div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, ri) => {
                if (row.section) return <tr key={ri} className="sec"><th className="rowhead" colSpan={cols.length + 1}>{row.section}</th></tr>;
                if (row.type === 'calc') return (
                  <tr key={row.key} className="calc-row">
                    <th className="rowhead"><span>{row.label}</span></th>
                    {cols.map((c) => <td key={c.id} className="calc-cell">{fmtR(row.calc(c.v))}</td>)}
                  </tr>
                );
                if (row.type === 'pctcalc') return (
                  <tr key={row.key}>
                    <th className="rowhead">
                      <span>{row.label}</span>
                      <button className="fill" title="Copy the first group’s value across all groups" onClick={() => fillRow(row.key)}>→</button>
                    </th>
                    {cols.map((c, ci) => (
                      <td key={c.id}>
                        <div className="pctcalc-cell">
                          <span className="pct-in"><input value={c.v[row.key]} onChange={(e) => setCell(ci, row.key, e.target.value)} /><span className="pct-sign">%</span></span>
                          <span className="pctcalc-eq">= {fmtR(row.calc(c.v))}</span>
                        </div>
                      </td>
                    ))}
                  </tr>
                );
                return (
                  <tr key={row.key}>
                    <th className="rowhead">
                      <span>{row.label}</span>
                      <button className="fill" title="Copy the first group’s value across all groups" onClick={() => fillRow(row.key)}>→</button>
                    </th>
                    {cols.map((c, ci) => (
                      <td key={c.id}><input type={row.type === 'date' ? 'date' : 'text'} value={c.v[row.key]} onChange={(e) => setCell(ci, row.key, e.target.value)} /></td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {cols && cols.length > 0 && (
          <section className="assign-section">
            <h4>Assign units to groups</h4>
            <div className="assign-grid">
              {properties.map((p) => p.units.length > 0 && (
                <div key={p.id} className="assign-prop">
                  <div className="assign-prop-name">{p.name}</div>
                  {p.units.map((u) => (
                    <div key={u.id} className="assign-row">
                      <span className="assign-unit">{u.name}</span>
                      <select value={u.pricingGroupId || ''} onChange={(e) => assign(u.id, e.target.value)}>
                        <option value="">— No group —</option>
                        {cols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        )}

        <p className="muted small" style={{ marginTop: 10 }}>Total for a stay = first night + (nights − 1) × every‑night rate, then weekly/monthly discount. The <b>→</b> copies the first group’s value across all groups.</p>
      </div>
    </div>
  );
}
