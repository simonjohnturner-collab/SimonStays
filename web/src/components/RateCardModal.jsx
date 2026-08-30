import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { centsToRand, randToCents } from '../money.js';

const FLEXES = [
  { key: 'flex1', pct: 'flex1Percent', label: 'Seasonal flex 1' },
  { key: 'flex2', pct: 'flex2Percent', label: 'Seasonal flex 2' },
  { key: 'flex3', pct: 'flex3Percent', label: 'Seasonal flex 3' },
];

// Per-unit pricing sheet matching Simon's template.
export default function RateCardModal({ unit, onClose, onSaved }) {
  const [f, setF] = useState(null);
  const [periods, setPeriods] = useState({ flex1: [], flex2: [], flex3: [] }); // flex -> [{start,end}]
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { rateCard: rc } = await api.getRateCard(unit.id);
      const specials = Array.isArray(rc.specialDates) ? rc.specialDates : [];
      const grp = { flex1: [], flex2: [], flex3: [] };
      specials.forEach((s) => { if (grp[s.flex]) grp[s.flex].push({ start: s.start || '', end: s.end || '' }); });
      setPeriods(grp);
      setF({
        breakage: r(rc.breakageDepositCents),
        n1: r(rc.nights1Cents), n2: r(rc.nights2Cents), n3: r(rc.nights3Cents), n4: r(rc.nights4PlusCents),
        weeklyDiscountPercent: rc.weeklyDiscountPercent || 0, monthlyDiscountPercent: rc.monthlyDiscountPercent || 0,
        weekendFlexPercent: rc.weekendFlexPercent || 0,
        flex1Percent: rc.flex1Percent || 0, flex2Percent: rc.flex2Percent || 0, flex3Percent: rc.flex3Percent || 0,
        early: r(rc.earlyCheckInCents), late: r(rc.lateCheckOutCents), cleaning: r(rc.cleaningCents), mattress: r(rc.mattressCents),
      });
    })();
    // eslint-disable-next-line
  }, [unit.id]);

  const set = (k, v) => setF({ ...f, [k]: v });
  const setPeriod = (flex, i, k, v) => setPeriods({ ...periods, [flex]: periods[flex].map((p, j) => (j === i ? { ...p, [k]: v } : p)) });
  const addPeriod = (flex) => setPeriods({ ...periods, [flex]: [...periods[flex], { start: '', end: '' }] });
  const rmPeriod = (flex, i) => setPeriods({ ...periods, [flex]: periods[flex].filter((_, j) => j !== i) });
  if (!f) return null;

  async function save() {
    setBusy(true);
    const specialDates = [];
    FLEXES.forEach(({ key }) => periods[key].forEach((p) => { if (p.start && p.end) specialDates.push({ flex: key, start: p.start, end: p.end }); }));
    try {
      const { rateCard } = await api.saveRateCard(unit.id, {
        breakageDepositCents: randToCents(f.breakage),
        nights1Cents: randToCents(f.n1), nights2Cents: randToCents(f.n2), nights3Cents: randToCents(f.n3), nights4PlusCents: randToCents(f.n4),
        weeklyDiscountPercent: num(f.weeklyDiscountPercent), monthlyDiscountPercent: num(f.monthlyDiscountPercent),
        weekendFlexPercent: num(f.weekendFlexPercent),
        flex1Percent: num(f.flex1Percent), flex2Percent: num(f.flex2Percent), flex3Percent: num(f.flex3Percent),
        earlyCheckInCents: randToCents(f.early), lateCheckOutCents: randToCents(f.late),
        cleaningCents: randToCents(f.cleaning), mattressCents: randToCents(f.mattress),
        specialDates,
      });
      onSaved && onSaved(rateCard);
    } catch (e) { alert(e.message); setBusy(false); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>Pricing · {unit.propertyName ? `${unit.propertyName} · ` : ''}{unit.name}</h3><button className="x" onClick={onClose}>×</button></div>
        <p className="muted small">Used by bookings and invoices (and later guest self-booking). Amounts in Rand.</p>

        <fieldset>
          <legend>Nightly rate by length of stay</legend>
          <div className="rate-grid">
            <label>1 night<input value={f.n1} onChange={(e) => set('n1', e.target.value)} placeholder="0" /></label>
            <label>2 nights<input value={f.n2} onChange={(e) => set('n2', e.target.value)} placeholder="0" /></label>
            <label>3 nights<input value={f.n3} onChange={(e) => set('n3', e.target.value)} placeholder="0" /></label>
            <label>4 nights & more<input value={f.n4} onChange={(e) => set('n4', e.target.value)} placeholder="0" /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Discounts, deposit & fees</legend>
          <div className="rate-grid">
            <label>Weekly discount %<input value={f.weeklyDiscountPercent} onChange={(e) => set('weeklyDiscountPercent', e.target.value)} /></label>
            <label>Monthly discount %<input value={f.monthlyDiscountPercent} onChange={(e) => set('monthlyDiscountPercent', e.target.value)} /></label>
            <label>Breakage deposit (R)<input value={f.breakage} onChange={(e) => set('breakage', e.target.value)} /></label>
            <label>Cleaning per clean (R)<input value={f.cleaning} onChange={(e) => set('cleaning', e.target.value)} /></label>
            <label>Early check-in (R)<input value={f.early} onChange={(e) => set('early', e.target.value)} /></label>
            <label>Late checkout (R)<input value={f.late} onChange={(e) => set('late', e.target.value)} /></label>
            <label>Extra mattress (R)<input value={f.mattress} onChange={(e) => set('mattress', e.target.value)} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Upward flexes (% on the nightly rate)</legend>
          <div className="rate-grid">
            <label>Weekend flex % <span className="muted small">(Fri/Sat)</span><input value={f.weekendFlexPercent} onChange={(e) => set('weekendFlexPercent', e.target.value)} /></label>
          </div>
          {FLEXES.map(({ key, pct, label }) => (
            <div key={key} className="flex-block">
              <div className="rate-grid">
                <label>{label} %<input value={f[pct]} onChange={(e) => set(pct, e.target.value)} /></label>
              </div>
              <div className="insta-head"><span className="muted small">{label} periods</span><button type="button" className="mini" onClick={() => addPeriod(key)}>+ Add period</button></div>
              {periods[key].length === 0 && <p className="muted small">No periods — this flex won’t apply until you add one.</p>}
              {periods[key].map((p, i) => (
                <div key={i} className="row2 ph-row">
                  <input type="date" value={p.start} onChange={(e) => setPeriod(key, i, 'start', e.target.value)} />
                  <input type="date" value={p.end} onChange={(e) => setPeriod(key, i, 'end', e.target.value)} />
                  <button className="del sm" onClick={() => rmPeriod(key, i)}>×</button>
                </div>
              ))}
            </div>
          ))}
        </fieldset>

        <div className="modal-actions">
          <div className="spacer" />
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={busy}>{busy ? '…' : 'Save pricing'}</button>
        </div>
      </div>
    </div>
  );
}

function r(cents) { return cents == null ? '' : String(centsToRand(cents)); }
function num(v) { return Number(v) || 0; }
