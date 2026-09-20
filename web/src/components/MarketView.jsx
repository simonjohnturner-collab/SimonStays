import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtR } from '../money.js';

// Market watch — competitor pricing intelligence for the building. Reads CAG's
// live booking engine (via the backend probe) and charts their standard vs
// promotional rates across the coming nights, so you can price against the market.
// Occupancy isn't published by the engine; CAG's own dynamic pricing is the
// demand signal we track instead.

const C_STD = '#2a78d6';   // standard rate  (categorical slot 1 — validated)
const C_PROMO = '#eb6834';  // promo rate     (categorical slot 2 — validated)
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
  const [days, setDays] = useState(30);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

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
    setBusy(true); setMsg('Probing CAG’s live engine… this takes a minute or two. The chart will fill in when it’s done.');
    try {
      await api.marketProbe(competitor.id, days);
      // Poll for the fresh capture (probe runs server-side, fire-and-forget).
      let tries = 0;
      const poll = async () => {
        tries += 1;
        try {
          const d = await api.marketPrices(competitor.id, days);
          const today = new Date().toISOString().slice(0, 10);
          if (d.capturedDate === today && d.roomTypes?.length) {
            setData(d);
            if (!d.roomTypes.some((r) => r.roomType === selected)) setSelected(d.roomTypes[0].roomType);
            setMsg(`Updated from CAG’s live rates (${d.roomTypes.length} room types).`);
            setBusy(false); return;
          }
        } catch (_) { /* keep polling */ }
        if (tries < 18) pollRef.current = setTimeout(poll, 10000);
        else { setMsg('Still probing — press Refresh in a moment.'); setBusy(false); }
      };
      pollRef.current = setTimeout(poll, 10000);
    } catch (e) { setMsg(e.message); setBusy(false); }
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

            {current && <PriceChart series={current.series} roomType={current.roomType.trim()} />}

            <SummaryTable roomTypes={roomTypes} />
            <p className="muted small mk-note">
              Occupancy isn’t published by the engine, so this tracks price instead — CAG’s revenue management moves rates with demand, so rising prices and shrinking promos mean the building is filling. Probe daily (it runs automatically at 03:20) to build the trend.
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

// ---- SVG line chart: standard vs promo across the forward nights ----
function PriceChart({ series, roomType }) {
  const [hover, setHover] = useState(null); // index
  const svgRef = useRef(null);
  const W = 760, H = 300, ml = 52, mr = 74, mt = 18, mb = 30;
  const plotW = W - ml - mr, plotH = H - mt - mb;

  const pts = series.filter((p) => p.priceCents != null);
  const hasPromo = pts.some((p) => p.promoPriceCents != null);
  const vals = pts.flatMap((p) => [p.priceCents, p.promoPriceCents].filter((v) => v != null));
  if (!pts.length || !vals.length) return <div className="mk-chart muted small">No price data for this room type.</div>;

  const rawMin = Math.min(...vals), rawMax = Math.max(...vals);
  const pad = Math.max(50_00, (rawMax - rawMin) * 0.15) || 100_00;
  const yMin = Math.max(0, Math.floor((rawMin - pad) / 100_00) * 100_00);
  const yMax = Math.ceil((rawMax + pad) / 100_00) * 100_00;
  const n = pts.length;
  const x = (i) => n === 1 ? ml + plotW / 2 : ml + (i / (n - 1)) * plotW;
  const y = (v) => mt + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const line = (key) => pts.map((p, i) => (p[key] != null ? `${i === 0 || pts[i - 1][key] == null ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}` : '')).join(' ');
  const yTicks = 4;
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => yMin + ((yMax - yMin) * i) / yTicks);
  const xEvery = Math.max(1, Math.round(n / 8));

  function onMove(e) {
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(x(i) - vx); if (d < bd) { bd = d; best = i; } }
    setHover(best);
  }

  const hp = hover != null ? pts[hover] : null;

  return (
    <div className="mk-chart">
      <div className="mk-legend">
        <span className="mk-leg"><i style={{ background: C_STD }} /> Standard rate</span>
        {hasPromo && <span className="mk-leg"><i style={{ background: C_PROMO }} /> Promo rate</span>}
        <span className="mk-leg-rt">{roomType}</span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="mk-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`CAG price for ${roomType}`}>
        {/* weekend markers */}
        {pts.map((p, i) => (dow(p.date) === 6 || dow(p.date) === 0) ? <line key={`wk${i}`} x1={x(i)} x2={x(i)} y1={mt} y2={mt + plotH} className="mk-weekend" /> : null)}
        {/* y grid + labels */}
        {ticks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={ml} x2={ml + plotW} y1={y(t)} y2={y(t)} className="mk-grid" />
            <text x={ml - 8} y={y(t) + 4} className="mk-ylab">{fmtR(t).replace('.00', '')}</text>
          </g>
        ))}
        {/* x labels */}
        {pts.map((p, i) => i % xEvery === 0 ? <text key={`x${i}`} x={x(i)} y={mt + plotH + 20} className="mk-xlab">{shortDate(p.date)}</text> : null)}
        {/* lines */}
        {hasPromo && <path d={line('promoPriceCents')} className="mk-path" style={{ stroke: C_PROMO }} strokeDasharray="4 3" />}
        <path d={line('priceCents')} className="mk-path" style={{ stroke: C_STD }} />
        {/* end direct labels */}
        <EndLabel pts={pts} i={n - 1} key_="priceCents" x={x} y={y} color={C_STD} text="Standard" />
        {hasPromo && <EndLabel pts={pts} i={n - 1} key_="promoPriceCents" x={x} y={y} color={C_PROMO} text="Promo" />}
        {/* hover */}
        {hp && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={mt} y2={mt + plotH} className="mk-cross" />
            {hp.priceCents != null && <circle cx={x(hover)} cy={y(hp.priceCents)} r="4" style={{ fill: C_STD }} className="mk-dot" />}
            {hp.promoPriceCents != null && <circle cx={x(hover)} cy={y(hp.promoPriceCents)} r="4" style={{ fill: C_PROMO }} className="mk-dot" />}
            <Tooltip x={x(hover)} y={mt} W={W} p={hp} />
          </g>
        )}
      </svg>
    </div>
  );
}

function EndLabel({ pts, i, key_, x, y, color, text }) {
  // last non-null point of the series
  let j = i; while (j >= 0 && pts[j][key_] == null) j -= 1;
  if (j < 0) return null;
  return (
    <g>
      <circle cx={x(j) + 8} cy={y(pts[j][key_])} r="3" style={{ fill: color }} />
      <text x={x(j) + 15} y={y(pts[j][key_]) + 4} className="mk-endlab">{text}</text>
    </g>
  );
}

function Tooltip({ x, y, W, p }) {
  const w = 132, h = p.promoPriceCents != null ? 56 : 40;
  const tx = Math.min(Math.max(x + 10, 4), W - w - 4);
  return (
    <g className="mk-tip" pointerEvents="none">
      <rect x={tx} y={y + 4} width={w} height={h} rx="6" className="mk-tip-box" />
      <text x={tx + 10} y={y + 21} className="mk-tip-date">{new Date(p.date + 'T12:00:00Z').toUTCString().slice(0, 11)}</text>
      <text x={tx + 10} y={y + 37} className="mk-tip-row"><tspan style={{ fill: C_STD }}>●</tspan> {p.priceCents != null ? fmtR(p.priceCents).replace('.00', '') : '—'}</text>
      {p.promoPriceCents != null && <text x={tx + 10} y={y + 51} className="mk-tip-row"><tspan style={{ fill: C_PROMO }}>●</tspan> {fmtR(p.promoPriceCents).replace('.00', '')} promo</text>}
    </g>
  );
}

function SummaryTable({ roomTypes }) {
  const rows = roomTypes.map((r) => {
    const std = r.series.map((p) => p.priceCents).filter((v) => v != null);
    const promo = r.series.map((p) => p.promoPriceCents).filter((v) => v != null);
    const med = median(std), lo = std.length ? Math.min(...std) : null, hi = std.length ? Math.max(...std) : null;
    const medPromo = median(promo);
    const disc = med != null && medPromo != null && med > 0 ? Math.round((1 - medPromo / med) * 100) : null;
    return { roomType: r.roomType.trim(), unitCount: r.unitCount, med, lo, hi, disc };
  });
  return (
    <table className="mk-table">
      <thead>
        <tr><th>Room type</th><th>Units</th><th>Median</th><th>Low</th><th>High</th><th>Promo disc.</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.roomType}>
            <td>{r.roomType}</td>
            <td className="mk-num">{r.unitCount ?? '—'}</td>
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
