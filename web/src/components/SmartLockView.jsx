import { useEffect, useState } from 'react';
import { api } from '../api.js';

const iso = (d) => (d || '').slice(0, 10);
const battClass = (b) => (b == null ? 'unknown' : b < 20 ? 'low' : b < 50 ? 'mid' : 'ok');

export default function SmartLockView({ onClose }) {
  const [units, setUnits] = useState(null);
  const [msg, setMsg] = useState('');
  const setMsgTemp = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1500); };

  async function load() { try { const r = await api.getSmartLocks(); setUnits(r.units); } catch (e) { setMsg(e.message); } }
  useEffect(() => { load(); }, []);

  const now = Date.now();
  const isCurrent = (b) => new Date(b.checkIn).getTime() <= now && now < new Date(b.checkOut).getTime();
  const missing = (b) => !(b.accessCode && String(b.accessCode).trim());

  const needCodes = (units || []).flatMap((u) => (u.bookings || []).filter(missing).map((b) => ({ u, b })));
  const lowBatt = (units || []).filter((u) => u.lockBattery != null && u.lockBattery < 20);

  const editCode = (bId, code) => setUnits((us) => us.map((u) => ({ ...u, bookings: u.bookings.map((x) => (x.id === bId ? { ...x, accessCode: code } : x)) })));
  const persistCode = (bId, code) => api.setBookingCode(bId, code).then(() => setMsgTemp('Saved.')).catch((e) => setMsg(e.message));
  const editBatt = (uId, val) => setUnits((us) => us.map((u) => (u.id === uId ? { ...u, lockBattery: val === '' ? null : Number(val) } : u)));
  const persistBatt = (uId, val) => api.setLockBattery(uId, val === '' ? null : Number(val)).then(() => setMsgTemp('Saved.')).catch((e) => setMsg(e.message));

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">SmartLock dashboard</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={load}>↻ Refresh</button>
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="sl-wrap">
        {!units ? <p className="muted small">Loading…</p> : units.length === 0 ? (
          <p className="muted small">No units are set to “Smart lock”. Set a unit’s <b>Access method</b> to <b>Smart lock</b> in Listings, then they’ll appear here.</p>
        ) : (
          <>
            <div className={`sl-recon ${needCodes.length ? 'warn' : 'ok'}`}>
              {needCodes.length === 0
                ? <span>✅ All current &amp; upcoming stays have a lock code.</span>
                : (
                  <span><b>⚠️ {needCodes.length} stay{needCodes.length > 1 ? 's' : ''} need a code:</b>{' '}
                    {needCodes.slice(0, 8).map(({ u, b }) => `${u.name} · ${b.guestName || '(guest)'} (${iso(b.checkIn)})`).join(', ')}
                    {needCodes.length > 8 ? '…' : ''}</span>
                )}
              {lowBatt.length > 0 && <div className="sl-lowbatt">🔋 Low battery: {lowBatt.map((u) => `${u.name} (${u.lockBattery}%)`).join(', ')}</div>}
              <div className="sl-note muted small">Codes &amp; battery are entered manually for now; they’ll auto‑populate once a smart‑lock provider is connected.</div>
            </div>

            <div className="sl-grid">
              {units.map((u) => (
                <section key={u.id} className="sl-card">
                  <div className="sl-head">
                    <div className="sl-titles">
                      <div className="sl-unit">{u.propertyName} · {u.name}</div>
                      {u.smartLockUrl
                        ? <a className="sl-link" href={u.smartLockUrl} target="_blank" rel="noreferrer">Open lock ↗</a>
                        : <span className="muted small">No lock link set</span>}
                    </div>
                    <label className={`sl-batt ${battClass(u.lockBattery)}`} title="Battery %">
                      🔋 <input type="number" min="0" max="100" value={u.lockBattery ?? ''} placeholder="—"
                        onChange={(e) => editBatt(u.id, e.target.value)} onBlur={(e) => persistBatt(u.id, e.target.value)} /><span className="pct">%</span>
                    </label>
                  </div>

                  <div className="sl-stays">
                    {u.bookings.length === 0 && <p className="muted small">No current or upcoming stays.</p>}
                    {u.bookings.map((b) => (
                      <div key={b.id} className={`sl-stay ${missing(b) ? 'nocode' : ''}`}>
                        <div className="sl-stay-info">
                          <span className={`sl-when ${isCurrent(b) ? 'now' : ''}`}>{isCurrent(b) ? 'In‑house' : 'Upcoming'}</span>
                          <span className="sl-guest">{b.guestName || '(guest)'}</span>
                          <span className="sl-dates">{iso(b.checkIn)} → {iso(b.checkOut)}</span>
                        </div>
                        <input className="sl-code" value={b.accessCode || ''} placeholder="No code"
                          onChange={(e) => editCode(b.id, e.target.value)} onBlur={(e) => persistCode(b.id, e.target.value)} />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
