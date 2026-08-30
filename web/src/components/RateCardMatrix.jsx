import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { centsToRand, randToCents } from '../money.js';

// One sheet for all units: pricing categories down the left, units across the top,
// every cell editable. Matches Simon's spreadsheet layout.
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

const r = (cents) => (cents == null ? '' : String(centsToRand(cents)));
const num = (v) => (v === '' || v == null ? 0 : Number(v) || 0);

function toValues(rc) {
  const specials = Array.isArray(rc.specialDates) ? rc.specialDates : [];
  const per = { flex1: [], flex2: [], flex3: [] };
  specials.forEach((s) => { if (per[s.flex]) per[s.flex].push(s); });
  const p = (flex, i, k) => (per[flex][i] ? per[flex][i][k] || '' : '');
  return {
    n1: r(rc.nights1Cents), n2: r(rc.nights2Cents), n3: r(rc.nights3Cents), n4: r(rc.nights4PlusCents),
    weekly: rc.weeklyDiscountPercent || '', monthly: rc.monthlyDiscountPercent || '',
    breakage: r(rc.breakageDepositCents), cleaning: r(rc.cleaningCents), early: r(rc.earlyCheckInCents), late: r(rc.lateCheckOutCents), mattress: r(rc.mattressCents),
    weekend: rc.weekendFlexPercent || '', flex1: rc.flex1Percent || '', flex2: rc.flex2Percent || '', flex3: rc.flex3Percent || '',
    f1s1: p('flex1', 0, 'start'), f1e1: p('flex1', 0, 'end'), f1s2: p('flex1', 1, 'start'), f1e2: p('flex1', 1, 'end'),
    f2s1: p('flex2', 0, 'start'), f2e1: p('flex2', 0, 'end'), f2s2: p('flex2', 1, 'start'), f2e2: p('flex2', 1, 'end'),
    f3s1: p('flex3', 0, 'start'), f3e1: p('flex3', 0, 'end'), f3s2: p('flex3', 1, 'start'), f3e2: p('flex3', 1, 'end'),
  };
}

function toCard(unitId, v) {
  const specialDates = [];
  const addP = (flex, s, e) => { if (v[s] && v[e]) specialDates.push({ flex, start: v[s], end: v[e] }); };
  addP('flex1', 'f1s1', 'f1e1'); addP('flex1', 'f1s2', 'f1e2');
  addP('flex2', 'f2s1', 'f2e1'); addP('flex2', 'f2s2', 'f2e2');
  addP('flex3', 'f3s1', 'f3e1'); addP('flex3', 'f3s2', 'f3e2');
  return {
    unitId,
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

  useEffect(() => {
    (async () => {
      const { units } = await api.getRateCards();
      setCols(units.map((u) => ({ unitId: u.id, propertyName: u.propertyName, name: u.name, v: toValues(u.rateCard || {}) })));
    })();
  }, []);

  function setCell(ci, key, val) {
    setCols((prev) => prev.map((c, i) => (i === ci ? { ...c, v: { ...c.v, [key]: val } } : c)));
  }
  function fillRow(key) {
    setCols((prev) => { if (!prev.length) return prev; const val = prev[0].v[key]; return prev.map((c) => ({ ...c, v: { ...c.v, [key]: val } })); });
  }
  async function saveAll() {
    setBusy(true); setMsg('');
    try {
      const r2 = await api.saveRateCards(cols.map((c) => toCard(c.unitId, c.v)));
      setMsg(`Saved ${r2.saved} unit${r2.saved === 1 ? '' : 's'}.`);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Pricing sheet</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={saveAll} disabled={busy || !cols}>{busy ? 'Saving…' : '💾 Save all'}</button>
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="matrix-wrap">
        {!cols ? <p className="muted small">Loading…</p> : cols.length === 0 ? (
          <p className="muted small">No units yet. Add a property and units first.</p>
        ) : (
          <table className="matrix">
            <thead>
              <tr>
                <th className="rowhead corner">Category</th>
                {cols.map((c) => (
                  <th key={c.unitId}><div className="mh-prop">{c.propertyName}</div><div className="mh-unit">{c.name}</div></th>
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
                    <button className="fill" title="Copy the first unit’s value across all units" onClick={() => fillRow(row.key)}>→</button>
                  </th>
                  {cols.map((c, ci) => (
                    <td key={c.unitId}>
                      <input type={row.type === 'date' ? 'date' : 'text'} value={c.v[row.key]} onChange={(e) => setCell(ci, row.key, e.target.value)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small" style={{ marginTop: 10 }}>Amounts in Rand · the <b>→</b> next to a row copies the first unit’s value across every unit (handy when pricing is shared).</p>
      </div>
    </div>
  );
}
