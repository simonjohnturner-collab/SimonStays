import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtR } from '../money.js';

// Market watch — competitor pricing intelligence for the building. Reads CAG's
// live booking engine (via the backend probe) and charts their standard vs
// promotional rates across the coming nights, so you can price against the market.
// Occupancy isn't published by the engine; CAG's own dynamic pricing is the
// demand signal we track instead.

const C_STD = '#2a78d6';   // CAG standard rate  (categorical slot 1 — validated)
const C_PROMO = '#eb6834';  // CAG promo rate     (categorical slot 2 — validated)
const C_MINE = '#1baf7a';   // my price           (categorical slot 3 — validated)
const CAG_SEED = { name: 'CAG — The Vantage', building: 'The Vantage, Rosebank', source: 'SITEMINDER_TBB', channelCode: 'TheVantageDirect', currency: 'ZAR' };

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dow(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
function shortDate(iso) { const d = new Date(iso + 'T12:00:00Z'); return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}`; }
function median(arr) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

export default function MarketView({ onClose }) {
  const [competitor, setCompetitor] = useState(null);
  const [noneYet, setNoneYet] = useState(false);
  const [data, setData] = useState(null); // { capturedDate, roomTypes: [...] }
  const [selected, setSelected] = useState(null); // room type name
  const [days, setDays] = useState(60);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);
  const [myUnits, setMyUnits] = useState([]);
  const [myUnitId, setMyUnitId] = useState('');
  const [myRates, setMyRates] = useState({}); // { iso: cents } — my own nightly rate

  // My units, for the "overlay my price" comparison line.
  useEffect(() => {
    api.listProperties()
      .then(({ properties }) => setMyUnits((properties || []).flatMap((p) => p.units.map((u) => ({ id: u.id, label: `${p.name} · ${u.name}` })))))
      .catch(() => {});
  }, []);

  // My nightly rates across the window (from my rate card / overrides).
  useEffect(() => {
    if (!myUnitId) { setMyRates({}); return; }
    const from = new Date().toISOString().slice(0, 10);
    const t = new Date(); t.setUTCDate(t.getUTCDate() + days);
    api.getNightRates(myUnitId, from, t.toISOString().slice(0, 10))
      .then(({ nights }) => { const m = {}; (nights || []).forEach((nt) => { if (nt.cents != null) m[nt.date] = nt.cents; }); setMyRates(m); })
      .catch(() => setMyRates({}));
  }, [myUnitId, days]);

  async function loadCompetitor() {
    const { competitors } = await api.marketCompetitors();
    const cag = competitors.find((c) => c.source === 'SITEMINDER_TBB' && c.active) || competitors[0] || null;
    setCompetitor(cag);
    setNoneYet(!cag);
    return cag;
  }

  async function loadPrices(c) {
    if (!c) return;
    try {
      const d = await api.marketPrices(c.id, days);
      setData(d);
      if (d.roomTypes?.length && !d.roomTypes.some((r) => r.roomType === selected)) {
        // default to a 1-bed if present (closest to Simon's units), else the first
        const oneBed = d.roomTypes.find((r) => /one bedroom apartment/i.test(r.roomType));
        setSelected((oneBed || d.roomTypes[0]).roomType);
      }
    } catch (e) { setMsg(e.message); }
  }

  useEffect(() => { loadCompetitor().then((c) => loadPrices(c)); return () => clearTimeout(pollRef.current); }, []); // eslint-disable-line
  useEffect(() => { if (competitor) loadPrices(competitor); }, [days]); // eslint-disable-line

  async function trackCAG() {
    setBusy(true); setMsg('');
    try {
      await api.marketAddCompetitor(CAG_SEED);
      const c = await loadCompetitor();
      setMsg('Tracking CAG — The Vantage. Run a probe to pull their live prices.');
      await loadPrices(c);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  async function probeNow() {
    if (!competitor) return;
    setBusy(true); setMsg('Probing CAG’s live engine… nights fill in as they come back (a minute or two for the full window).');
    try {
      await api.marketProbe(competitor.id, days);
    } catch (e) { setMsg(e.message); setBusy(false); return; }
    // The probe runs server-side and writes nights one at a time, so keep polling
    // and grow the chart until the night count stops rising (probe finished) or we
    // reach the window — not just until the first night appears.
    let tries = 0, stable = 0, lastNights = -1;
    const poll = async () => {
      tries += 1;
      try {
        const d = await api.marketPrices(competitor.id, days);
        const today = new Date().toISOString().slice(0, 10);
        if (d.capturedDate === today && d.roomTypes?.length) {
          setData(d); // live-growing chart
          if (!d.roomTypes.some((r) => r.roomType === selected)) setSelected(d.roomTypes[0].roomType);
          const nights = Math.max(...d.roomTypes.map((r) => r.series.length));
          if (nights === lastNights) stable += 1; else { stable = 0; lastNights = nights; }
          if (stable >= 2 || nights >= days) {
            setMsg(`Updated from CAG’s live rates — ${nights} nights, ${d.roomTypes.length} room types.`);
            setBusy(false); return;
          }
          setMsg(`Probing… ${nights} nights so far.`);
        }
      } catch (_) { /* keep polling */ }
      if (tries < 60) pollRef.current = setTimeout(poll, 6000);
      else { setMsg('Probe is taking a while — press ↻ Refresh to pull the latest.'); setBusy(false); }
    };
    pollRef.current = setTimeout(poll, 6000);
  }

  // Total units per room type isn't published by the engine, so it's the host's
  // own estimate — stored on the competitor and used to weight the market view.
  async function saveUnitCount(roomType, value) {
    if (!competitor) return;
    const raw = String(value).trim();
    const n = raw === '' ? null : Math.max(0, Math.round(Number(raw)));
    if (n != null && Number.isNaN(n)) return;
    const merged = { ...(competitor.unitCounts || {}) };
    if (n == null) delete merged[roomType]; else merged[roomType] = n;
    try {
      const { competitor: updated } = await api.marketUpdateCompetitor(competitor.id, { unitCounts: merged });
      setCompetitor(updated);
      setData((d) => d ? { ...d, roomTypes: d.roomTypes.map((r) => (r.roomType === roomType ? { ...r, unitCount: n } : r)) } : d);
    } catch (e) { setMsg(e.message); }
  }

  const roomTypes = data?.roomTypes || [];
  const current = roomTypes.find((r) => r.roomType === selected) || null;

  // Stat tiles from the nearest upcoming night across all room types.
  const tiles = useMemo(() => computeTiles(roomTypes), [roomTypes]);

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Market watch · The Vantage</span>
        <div className="spacer" />
        {competitor && (
          <>
            <select className="mk-days" value={days} onChange={(e) => setDays(Number(e.target.value))} title="Window">
              <option value={14}>Next 14 nights</option>
              <option value={30}>Next 30 nights</option>
              <option value={60}>Next 60 nights</option>
              <option value={90}>Next 90 nights</option>
            </select>
            <button className="ghost" onClick={() => loadPrices(competitor)} disabled={busy}>↻ Refresh</button>
            <button className="ghost" onClick={probeNow} disabled={busy}>{busy ? 'Probing…' : '📡 Probe now'}</button>
          </>
        )}
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="mk-wrap">
        {msg && <div className="mk-msg">{msg}</div>}

        {noneYet ? (
          <div className="mk-empty">
            <h3>Track the building’s market</h3>
            <p className="muted">CAG (Corporate Apartment Group) runs the biggest block at The Vantage — ~51 units across 7 room types, on a live SiteMinder booking engine. Start tracking them to chart their standard and promotional rates against your own pricing.</p>
            <button className="wide" style={{ maxWidth: 320 }} onClick={trackCAG} disabled={busy}>➕ Track CAG — The Vantage</button>
          </div>
        ) : !data || !data.capturedDate ? (
          <div className="mk-empty">
            <h3>No snapshots yet</h3>
            <p className="muted">Run a probe to pull CAG’s live prices for the coming nights. It reads their public booking engine once — no login, no bookings made.</p>
            <button className="wide" style={{ maxWidth: 240 }} onClick={probeNow} disabled={busy}>📡 Probe now</button>
          </div>
        ) : (
          <>
            <div className="mk-sub muted small">
              {competitor.name} · captured {shortDate(data.capturedDate)} · prices are per night, incl. tax ({data.currency})
            </div>

            <div className="mk-tiles">
              <Tile label="Cheapest tonight" value={tiles.lo != null ? fmtR(tiles.lo) : '—'} sub={tiles.loName} />
              <Tile label="Dearest tonight" value={tiles.hi != null ? fmtR(tiles.hi) : '—'} sub={tiles.hiName} />
              <Tile label="Avg discount depth" value={tiles.discPct != null ? `${tiles.discPct}%` : 'none'} sub={tiles.discPct != null ? 'promo vs standard' : 'no promo running'} />
              <Tile label="Room types tracked" value={String(roomTypes.length)} sub={`over next ${days} nights`} />
            </div>

            <div className="mk-tabs">
              {roomTypes.map((r) => (
                <button key={r.roomType} className={`mk-tab ${r.roomType === selected ? 'on' : ''}`} onClick={() => setSelected(r.roomType)}>
                  {r.roomType.trim()}
                </button>
              ))}
            </div>

            <div className="mk-mine-row">
              <label>Overlay my price:</label>
              <select value={myUnitId} onChange={(e) => setMyUnitId(e.target.value)}>
                <option value="">— none —</option>
                {myUnits.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
              {myUnitId && !Object.keys(myRates).length && <span className="muted small">No rate card on this unit yet — set its pricing to compare.</span>}
            </div>

            {current && <PriceChart {...buildLines(current, myUnitId, myRates)} title={current.roomType.trim()} />}

            <SummaryTable roomTypes={roomTypes} onSaveUnits={saveUnitCount} />
            <p className="muted small mk-note">
              <b>Units</b> is your own estimate per room type (CAG doesn’t publish it) — type a number to set it; it weights the market view. Live <i>available</i> units per category aren’t exposed by the engine yet (see note below). Occupancy itself isn’t published, so this tracks price: CAG’s revenue management moves rates with demand, so rising prices and shrinking promos mean the building is filling. The daily probe (03:20) builds the trend.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div className="mk-tile">
      <div className="mk-tile-label">{label}</div>
      <div className="mk-tile-value">{value}</div>
      {sub && <div className="mk-tile-sub">{sub}</div>}
    </div>
  );
}

function computeTiles(roomTypes) {
  // Use each room type's nearest-night standard price for lo/hi; average the
  // promo discount across room types where a promo is offered.
  let lo = null, hi = null, loName = '', hiName = '';
  const discs = [];
  for (const r of roomTypes) {
    const first = r.series.find((p) => p.priceCents != null);
    if (first) {
      if (lo == null || first.priceCents < lo) { lo = first.priceCents; loName = r.roomType.trim(); }
      if (hi == null || first.priceCents > hi) { hi = first.priceCents; hiName = r.roomType.trim(); }
    }
    const withPromo = r.series.filter((p) => p.priceCents != null && p.promoPriceCents != null && p.promoPriceCents < p.priceCents);
    for (const p of withPromo) discs.push(1 - p.promoPriceCents / p.priceCents);
  }
  const discPct = discs.length ? Math.round((discs.reduce((a, b) => a + b, 0) / discs.length) * 100) : null;
  return { lo, hi, loName, hiName, discPct };
}

// Build the chart's x-domain (dates) and its lines: CAG standard/promo + my price.
function buildLines(current, myUnitId, myRates) {
  const dates = current.series.map((p) => p.date);
  const stdBy = {}, promoBy = {};
  current.series.forEach((p) => { if (p.priceCents != null) stdBy[p.date] = p.priceCents; if (p.promoPriceCents != null) promoBy[p.date] = p.promoPriceCents; });
  const lines = [{ key: 'std', label: 'CAG standard', color: C_STD, byDate: stdBy }];
  if (Object.keys(promoBy).length) lines.push({ key: 'promo', label: 'CAG promo', color: C_PROMO, dash: '4 3', byDate: promoBy });
  if (myUnitId && Object.keys(myRates).length) lines.push({ key: 'mine', label: 'My price', color: C_MINE, byDate: myRates });
  return { dates, lines };
}

// ---- SVG line chart: any number of price lines across the forward nights ----
function PriceChart({ dates, lines, title }) {
  const [hover, setHover] = useState(null); // date index
  const svgRef = useRef(null);
  const W = 760, H = 300, ml = 52, mr = 92, mt = 18, mb = 30;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = dates.length;
  const vals = lines.flatMap((l) => dates.map((d) => l.byDate[d]).filter((v) => v != null));
  if (!n || !vals.length) return <div className="mk-chart muted small">No price data yet.</div>;

  const rawMin = Math.min(...vals), rawMax = Math.max(...vals);
  const pad = Math.max(5000, (rawMax - rawMin) * 0.15) || 10000;
  const yMin = Math.max(0, Math.floor((rawMin - pad) / 10000) * 10000);
  const yMax = Math.ceil((rawMax + pad) / 10000) * 10000;
  const x = (i) => n === 1 ? ml + plotW / 2 : ml + (i / (n - 1)) * plotW;
  const y = (v) => mt + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const path = (l) => dates.map((d, i) => { const v = l.byDate[d]; if (v == null) return ''; const prev = i > 0 ? l.byDate[dates[i - 1]] : null; return `${prev == null ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; }).join(' ');
  const ticks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);
  const xEvery = Math.max(1, Math.round(n / 8));

  function onMove(e) {
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(x(i) - vx); if (d < bd) { bd = d; best = i; } }
    setHover(best);
  }
  const hd = hover != null ? dates[hover] : null;

  return (
    <div className="mk-chart">
      <div className="mk-legend">
        {lines.map((l) => <span key={l.key} className="mk-leg"><i style={{ background: l.color }} /> {l.label}</span>)}
        <span className="mk-leg-rt">{title}</span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="mk-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`Price comparison for ${title}`}>
        {dates.map((d, i) => (dow(d) === 6 || dow(d) === 0) ? <line key={`wk${i}`} x1={x(i)} x2={x(i)} y1={mt} y2={mt + plotH} className="mk-weekend" /> : null)}
        {ticks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={ml} x2={ml + plotW} y1={y(t)} y2={y(t)} className="mk-grid" />
            <text x={ml - 8} y={y(t) + 4} className="mk-ylab">{fmtR(t).replace('.00', '')}</text>
          </g>
        ))}
        {dates.map((d, i) => i % xEvery === 0 ? <text key={`x${i}`} x={x(i)} y={mt + plotH + 20} className="mk-xlab">{shortDate(d)}</text> : null)}
        {lines.map((l) => <path key={l.key} d={path(l)} className="mk-path" style={{ stroke: l.color }} strokeDasharray={l.dash || undefined} />)}
        {lines.map((l) => <EndLabel key={`e${l.key}`} dates={dates} line={l} x={x} y={y} />)}
        {hd && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={mt} y2={mt + plotH} className="mk-cross" />
            {lines.map((l) => l.byDate[hd] != null ? <circle key={`d${l.key}`} cx={x(hover)} cy={y(l.byDate[hd])} r="4" style={{ fill: l.color }} className="mk-dot" /> : null)}
            <Tooltip x={x(hover)} y={mt} W={W} date={hd} lines={lines} />
          </g>
        )}
      </svg>
    </div>
  );
}

function EndLabel({ dates, line, x, y }) {
  let j = dates.length - 1; while (j >= 0 && line.byDate[dates[j]] == null) j -= 1;
  if (j < 0) return null;
  const v = line.byDate[dates[j]];
  return (
    <g>
      <circle cx={x(j) + 8} cy={y(v)} r="3" style={{ fill: line.color }} />
      <text x={x(j) + 14} y={y(v) + 4} className="mk-endlab">{line.label.replace('CAG ', '')}</text>
    </g>
  );
}

function Tooltip({ x, y, W, date, lines }) {
  const rows = lines.filter((l) => l.byDate[date] != null);
  const w = 152, h = 20 + rows.length * 15;
  const tx = Math.min(Math.max(x + 10, 4), W - w - 4);
  return (
    <g className="mk-tip" pointerEvents="none">
      <rect x={tx} y={y + 4} width={w} height={h} rx="6" className="mk-tip-box" />
      <text x={tx + 10} y={y + 20} className="mk-tip-date">{new Date(date + 'T12:00:00Z').toUTCString().slice(0, 11)}</text>
      {rows.map((l, i) => (
        <text key={l.key} x={tx + 10} y={y + 35 + i * 15} className="mk-tip-row"><tspan style={{ fill: l.color }}>●</tspan> {l.label}: {fmtR(l.byDate[date]).replace('.00', '')}</text>
      ))}
    </g>
  );
}

function SummaryTable({ roomTypes, onSaveUnits }) {
  const rows = roomTypes.map((r) => {
    const std = r.series.map((p) => p.priceCents).filter((v) => v != null);
    const promo = r.series.map((p) => p.promoPriceCents).filter((v) => v != null);
    const med = median(std), lo = std.length ? Math.min(...std) : null, hi = std.length ? Math.max(...std) : null;
    const medPromo = median(promo);
    const disc = med != null && medPromo != null && med > 0 ? Math.round((1 - medPromo / med) * 100) : null;
    return { roomType: r.roomType, label: r.roomType.trim(), unitCount: r.unitCount, med, lo, hi, disc };
  });
  return (
    <table className="mk-table">
      <thead>
        <tr><th>Room type</th><th>Units</th><th>Median</th><th>Low</th><th>High</th><th>Promo disc.</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.roomType}>
            <td>{r.label}</td>
            <td className="mk-num">
              <input
                className="mk-units-in"
                type="number"
                min="0"
                defaultValue={r.unitCount ?? ''}
                placeholder="—"
                title="Your estimate of CAG's units of this type"
                onBlur={(e) => onSaveUnits(r.roomType, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
            </td>
            <td className="mk-num">{r.med != null ? fmtR(r.med).replace('.00', '') : '—'}</td>
            <td className="mk-num">{r.lo != null ? fmtR(r.lo).replace('.00', '') : '—'}</td>
            <td className="mk-num">{r.hi != null ? fmtR(r.hi).replace('.00', '') : '—'}</td>
            <td className="mk-num">{r.disc != null ? `${r.disc}%` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
