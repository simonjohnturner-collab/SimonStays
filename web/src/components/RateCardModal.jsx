import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { centsToRand, randToCents } from '../money.js';

// Per-property pricing sheet. Rates entered in Rand, stored as cents.
export default function RateCardModal({ property, onClose, onSaved }) {
  const [f, setF] = useState(null);
  const [pubs, setPubs] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { rateCard: rc } = await api.getRateCard(property.id);
      const specials = Array.isArray(rc.specialDates) ? rc.specialDates : [];
      const xmas = specials.find((s) => s.category === 'christmas') || {};
      const easter = specials.find((s) => s.category === 'easter') || {};
      setPubs(specials.filter((s) => s.category === 'public').map((s) => ({ start: s.start || '', end: s.end || '' })));
      setF({
        n1: r(rc.nights1Cents), n2: r(rc.nights2Cents), n3: r(rc.nights3Cents), n4: r(rc.nights4Cents), n5: r(rc.nights5PlusCents),
        weeklyDiscountPercent: rc.weeklyDiscountPercent || 0, monthlyDiscountPercent: rc.monthlyDiscountPercent || 0,
        cleaning: r(rc.cleaningCents), mattress: r(rc.mattressCents),
        weekend: rc.weekendSurchargePercent || 0, publicH: rc.publicHolidaySurchargePercent || 0,
        christmas: rc.christmasSurchargePercent || 0, easter: rc.easterSurchargePercent || 0,
        xmasStart: xmas.start || '', xmasEnd: xmas.end || '', easterStart: easter.start || '', easterEnd: easter.end || '',
      });
    })();
    // eslint-disable-next-line
  }, [property.id]);

  const set = (k, v) => setF({ ...f, [k]: v });
  if (!f) return null;

  async function save() {
    setBusy(true);
    const specialDates = [];
    if (f.xmasStart && f.xmasEnd) specialDates.push({ category: 'christmas', start: f.xmasStart, end: f.xmasEnd });
    if (f.easterStart && f.easterEnd) specialDates.push({ category: 'easter', start: f.easterStart, end: f.easterEnd });
    pubs.forEach((p) => { if (p.start && p.end) specialDates.push({ category: 'public', start: p.start, end: p.end }); });
    try {
      const { rateCard } = await api.saveRateCard(property.id, {
        nights1Cents: randToCents(f.n1), nights2Cents: randToCents(f.n2), nights3Cents: randToCents(f.n3),
        nights4Cents: randToCents(f.n4), nights5PlusCents: randToCents(f.n5),
        weeklyDiscountPercent: num(f.weeklyDiscountPercent), monthlyDiscountPercent: num(f.monthlyDiscountPercent),
        cleaningCents: randToCents(f.cleaning), mattressCents: randToCents(f.mattress),
        weekendSurchargePercent: num(f.weekend), publicHolidaySurchargePercent: num(f.publicH),
        christmasSurchargePercent: num(f.christmas), easterSurchargePercent: num(f.easter),
        specialDates,
      });
      onSaved && onSaved(rateCard);
    } catch (e) { alert(e.message); setBusy(false); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>Pricing sheet · {property.name}</h3><button className="x" onClick={onClose}>×</button></div>
        <p className="muted small">Used by the booking form and invoices. Rates in Rand, per night.</p>

        <fieldset>
          <legend>Nightly rate by length of stay</legend>
          <div className="rate-grid">
            <label>1 night<input value={f.n1} onChange={(e) => set('n1', e.target.value)} placeholder="0.00" /></label>
            <label>2 nights<input value={f.n2} onChange={(e) => set('n2', e.target.value)} placeholder="0.00" /></label>
            <label>3 nights<input value={f.n3} onChange={(e) => set('n3', e.target.value)} placeholder="0.00" /></label>
            <label>4 nights<input value={f.n4} onChange={(e) => set('n4', e.target.value)} placeholder="0.00" /></label>
            <label>5+ nights<input value={f.n5} onChange={(e) => set('n5', e.target.value)} placeholder="0.00" /></label>
          </div>
          <p className="muted small">Blank tiers fall back to the nearest one set.</p>
        </fieldset>

        <fieldset>
          <legend>Discounts & fees</legend>
          <div className="rate-grid">
            <label>Weekly discount %<input value={f.weeklyDiscountPercent} onChange={(e) => set('weeklyDiscountPercent', e.target.value)} /></label>
            <label>Monthly discount %<input value={f.monthlyDiscountPercent} onChange={(e) => set('monthlyDiscountPercent', e.target.value)} /></label>
            <label>Cleaning (R)<input value={f.cleaning} onChange={(e) => set('cleaning', e.target.value)} /></label>
            <label>Extra mattress (R)<input value={f.mattress} onChange={(e) => set('mattress', e.target.value)} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Seasonal surcharges (% on the nightly rate)</legend>
          <div className="rate-grid">
            <label>Weekend % <span className="muted small">(Fri/Sat)</span><input value={f.weekend} onChange={(e) => set('weekend', e.target.value)} /></label>
            <label>Public holiday %<input value={f.publicH} onChange={(e) => set('publicH', e.target.value)} /></label>
            <label>Christmas %<input value={f.christmas} onChange={(e) => set('christmas', e.target.value)} /></label>
            <label>Easter %<input value={f.easter} onChange={(e) => set('easter', e.target.value)} /></label>
          </div>
          <div className="row2">
            <label>Christmas from<input type="date" value={f.xmasStart} onChange={(e) => set('xmasStart', e.target.value)} /></label>
            <label>Christmas to<input type="date" value={f.xmasEnd} onChange={(e) => set('xmasEnd', e.target.value)} /></label>
          </div>
          <div className="row2">
            <label>Easter from<input type="date" value={f.easterStart} onChange={(e) => set('easterStart', e.target.value)} /></label>
            <label>Easter to<input type="date" value={f.easterEnd} onChange={(e) => set('easterEnd', e.target.value)} /></label>
          </div>
          <div className="insta-head"><span>Public holidays</span><button type="button" className="mini" onClick={() => setPubs([...pubs, { start: '', end: '' }])}>+ Add</button></div>
          {pubs.map((p, i) => (
            <div key={i} className="row2 ph-row">
              <input type="date" value={p.start} onChange={(e) => setPubs(pubs.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
              <input type="date" value={p.end} onChange={(e) => setPubs(pubs.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
              <button className="del sm" onClick={() => setPubs(pubs.filter((_, j) => j !== i))}>×</button>
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
