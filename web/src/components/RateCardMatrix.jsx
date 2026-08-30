import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { centsToRand, randToCents } from '../money.js';

// One sheet: pricing categories down the left, pricing GROUPS across the top.
// Units are assigned to groups on the property page; a group's prices apply to
// every unit in it.
const ROWS = [
  { section: 'Nightly rate' },
  { key: 'n1', label: '1 night', type: 'money' },
  { key: 'n2', label: '2 nights', type: 'money' },
  { key: 'n3', label: '3 nights', type: 'money' },
  { key: 'n4', label: '4 nights & more', type: 'money' },
  { section: 'Discounts, deposit & fees' },
  { key: 'weekly', label: 'Weekly discount %', type: 'pct' },
  { key: 'monthly', label: 'Monthly discount %', type: 'pct' },
  { key: 'breakage', label: 'Breakage deposit', type: 'money' },
  { key: 'cleaning', label: 'Cleaning per clean', type: 'money' },
  { key: 'early', label: 'Early check-in', type: 'money' },
  { key: 'late', label: 'Late checkout', type: 'money' },
  { key: 'mattress', label: 'Extra mattress', type: 'money' },
  { section: 'Upward flexes (%)' },
  { key: 'weekend', label: 'Weekend flex %', type: 'pct' },
  { key: 'flex1', label: 'Seasonal flex 1 %', type: 'pct' },
  { key: 'flex2', label: 'Seasonal flex 2 %', type: 'pct' },
  { key: 'flex3', label: 'Seasonal flex 3 %', type: 'pct' },
  { section: 'Seasonal flex periods' },
  { key: 'f1s1', label: 'Flex 1 · start', type: 'date' }, { key: 'f1e1', label: 'Flex 1 · end', type: 'date' },
  { key: 'f1s2', label: 'Flex 1 · start (2)', type: 'date' }, { key: 'f1e2', label: 'Flex 1 · end (2)', type: 'date' },
  { key: 'f2s1', label: 'Flex 2 · start', type: 'date' }, { key: 'f2e1', label: 'Flex 2 · end', type: 'date' },
  { key: 'f2s2', label: 'Flex 2 · start (2)', type: 'date' }, { key: 'f2e2', label: 'Flex 2 · end (2)', type: 'date' },
  { key: 'f3s1', label: 'Flex 3 · start', type: 'date' }, { key: 'f3e1', label: 'Flex 3 · end', type: 'date' },
  { key: 'f3s2', label: 'Flex 3 · start (2)', type: 'date' }, { key: 'f3e2', label: 'Flex 3 · end (2)', type: 'date' },
];

const r = (c) => (c == null ? '' : String(centsToRand(c)));
const num = (v) => (v === '' || v == null ? 0 : Number(v) || 0);

function toValues(g) {
  const specials = Array.isArray(g.specialDates) ? g.specialDates : [];
  const per = { flex1: [], flex2: [], flex3: [] };
  specials.forEach((s) => { if (per[s.flex]) per[s.flex].push(s); });
  const p = (flex, i, k) => (per[flex][i] ? per[flex][i][k] || '' : '');
  return {
    n1: r(g.nights1Cents), n2: r(g.nights2Cents), n3: r(g.nights3Cents), n4: r(g.nights4PlusCents),
    weekly: g.weeklyDiscountPercent || '', monthly: g.monthlyDiscountPercent || '',
    breakage: r(g.breakageDepositCents), cleaning: r(g.cleaningCents), early: r(g.earlyCheckInCents), late: r(g.lateCheckOutCents), mattress: r(g.mattressCents),
    weekend: g.weekendFlexPercent || '', flex1: g.flex1Percent || '', flex2: g.flex2Percent || '', flex3: g.flex3Percent || '',
    f1s1: p('flex1', 0, 'start'), f1e1: p('flex1', 0, 'end'), f1s2: p('flex1', 1, 'start'), f1e2: p('flex1', 1, 'end'),
    f2s1: p('flex2', 0, 'start'), f2e1: p('flex2', 0, 'end'), f2s2: p('flex2', 1, 'start'), f2e2: p('flex2', 1, 'end'),
    f3s1: p('flex3', 0, 'start'), f3e1: p('flex3', 0, 'end'), f3s2: p('flex3', 1, 'start'), f3e2: p('flex3', 1, 'end'),
  };
}

function toPayload(name, v) {
  const specialDates = [];
  const addP = (flex, s, e) => { if (v[s] && v[e]) specialDates.push({ flex, start: v[s], end: v[e] }); };
  addP('flex1', 'f1s1', 'f1e1'); addP('flex1', 'f1s2', 'f1e2');
  addP('flex2', 'f2s1', 'f2e1'); addP('flex2', 'f2s2', 'f2e2');
  addP('flex3', 'f3s1', 'f3e1'); addP('flex3', 'f3s2', 'f3e2');
  return {
    name,
    nights1Cents: randToCents(v.n1), nights2Cents: randToCents(v.n2), nights3Cents: randToCents(v.n3), nights4PlusCents: randToCents(v.n4),
    weeklyDiscountPercent: num(v.weekly), monthlyDiscountPercent: num(v.monthly),
    breakageDepositCents: randToCents(v.breakage), cleaningCents: randToCents(v.cleaning),
    earlyCheckInCents: randToCents(v.early), lateCheckOutCents: randToCents(v.late), mattressCents: randToCents(v.mattress),
    weekendFlexPercent: num(v.weekend), flex1Percent: num(v.flex1), flex2Percent: num(v.flex2), flex3Percent: num(v.flex3),
    specialDates,
  };
}

export default function RateCardMatrix({ onClose }) {
  const [cols, setCols] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const { groups } = await api.listGroups();
    setCols(groups.map((g) => ({ id: g.id, name: g.name, units: (g.unitIds || []).length, v: toValues(g) })));
  }
  useEffect(() => { load(); }, []);

  const setCell = (ci, key, val) => setCols((p) => p.map((c, i) => (i === ci ? { ...c, v: { ...c.v, [key]: val } } : c)));
  const setName = (ci, val) => setCols((p) => p.map((c, i) => (i === ci ? { ...c, name: val } : c)));
  const fillRow = (key) => setCols((p) => (p.length ? p.map((c) => ({ ...c, v: { ...c.v, [key]: p[0].v[key] } })) : p));

  async function newGroup() {
    const name = window.prompt('Group name (e.g. Firenza, or Studios)');
    if (!name) return;
    await api.createGroup(name.trim());
    await load();
  }
  async function removeGroup(ci) {
    const c = cols[ci];
    if (!window.confirm(`Delete group “${c.name}”? Units in it become unassigned.`)) return;
    await api.deleteGroup(c.id);
    await load();
  }
  async function saveAll() {
    setBusy(true); setMsg('');
    try {
      await Promise.all(cols.map((c) => api.updateGroup(c.id, toPayload(c.name, c.v))));
      setMsg('Saved.');
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
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
          <p className="muted small">No pricing groups yet. Create one with <b>＋ New group</b>, then assign units to it on the property page (☰ → Add or edit a property).</p>
        ) : (
          <table className="matrix">
            <thead>
              <tr>
                <th className="rowhead corner">Category</th>
                {cols.map((c, ci) => (
                  <th key={c.id} className="grouphead">
                    <input className="gname" value={c.name} onChange={(e) => setName(ci, e.target.value)} />
                    <div className="gsub">{c.units} unit{c.units === 1 ? '' : 's'} <button className="del sm gdel" title="Delete group" onClick={() => removeGroup(ci)}>×</button></div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, ri) => row.section ? (
                <tr key={ri} className="sec"><th className="rowhead" colSpan={cols.length + 1}>{row.section}</th></tr>
              ) : (
                <tr key={row.key}>
                  <th className="rowhead">
                    <span>{row.label}</span>
                    <button className="fill" title="Copy the first group’s value across all groups" onClick={() => fillRow(row.key)}>→</button>
                  </th>
                  {cols.map((c, ci) => (
                    <td key={c.id}><input type={row.type === 'date' ? 'date' : 'text'} value={c.v[row.key]} onChange={(e) => setCell(ci, row.key, e.target.value)} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small" style={{ marginTop: 10 }}>Assign units to groups on the property page (☰ → Add or edit a property). The <b>→</b> copies the first group’s value across all groups.</p>
      </div>
    </div>
  );
}
