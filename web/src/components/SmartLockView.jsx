import { useEffect, useState } from 'react';
import { api } from '../api.js';

const iso = (d) => (d || '').slice(0, 10);
const battClass = (b) => (b == null ? 'unknown' : b < 20 ? 'low' : b < 50 ? 'mid' : 'ok');
const fmtWhen = (d) => (d ? new Date(d).toLocaleString() : '—');

// Turn the provider's raw attribute object into readable label/value rows.
function detailRows(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const skip = new Set(['name', 'device_name']);
  return Object.entries(raw)
    .filter(([k, v]) => !skip.has(k) && v != null && typeof v !== 'object')
    .map(([k, v]) => [k.replace(/_/g, ' '), String(v)]);
}

export default function SmartLockView({ onClose }) {
  const [units, setUnits] = useState(null);
  const [provider, setProvider] = useState(null);
  const [devices, setDevices] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [cid, setCid] = useState('');
  const [csecret, setCsecret] = useState('');
  const setMsgTemp = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2500); };

  async function load() {
    try { const r = await api.getSmartLocks(); setUnits(r.units); setProvider(r.provider); }
    catch (e) { setMsg(e.message); }
  }
  useEffect(() => {
    load();
    // Surface the OAuth callback result (?smartlock=connected|error&msg=…).
    const p = new URLSearchParams(window.location.search);
    if (p.get('smartlock') === 'connected') setMsgTemp('RemoteLock connected ✅');
    else if (p.get('smartlock') === 'error') setMsgTemp(`RemoteLock error: ${p.get('msg') || 'failed'}`);
    if (p.get('smartlock')) window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const now = Date.now();
  const isCurrent = (b) => new Date(b.checkIn).getTime() <= now && now < new Date(b.checkOut).getTime();
  const missing = (b) => !(b.accessCode && String(b.accessCode).trim());

  const needCodes = (units || []).flatMap((u) => (u.bookings || []).filter(missing).map((b) => ({ u, b })));
  const lowBatt = (units || []).filter((u) => u.lockBattery != null && u.lockBattery < 20);

  const editCode = (bId, code) => setUnits((us) => us.map((u) => ({ ...u, bookings: u.bookings.map((x) => (x.id === bId ? { ...x, accessCode: code } : x)) })));
  const persistCode = (bId, code) => api.setBookingCode(bId, code).then(() => setMsgTemp('Saved.')).catch((e) => setMsg(e.message));
  const editBatt = (uId, val) => setUnits((us) => us.map((u) => (u.id === uId ? { ...u, lockBattery: val === '' ? null : Number(val) } : u)));
  const persistBatt = (uId, val) => api.setLockBattery(uId, val === '' ? null : Number(val)).then(() => setMsgTemp('Saved.')).catch((e) => setMsg(e.message));

  // Connect via client-credentials: send the Application ID + Secret, the server
  // mints a token immediately — no redirect, no spinning page.
  async function saveAndConnect() {
    if (!cid.trim() && !hasCreds) { setMsg('Enter your RemoteLock Application ID and Secret first.'); return; }
    if (cid.trim() && !csecret.trim()) { setMsg('Enter the Secret too.'); return; }
    setBusy(true);
    try {
      await api.connectLock({ clientId: cid.trim(), clientSecret: csecret.trim() });
      setCid(''); setCsecret(''); await load(); setMsgTemp('RemoteLock connected ✅');
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function disconnect() {
    if (!window.confirm('Disconnect RemoteLock? Units stay linked but live data stops updating.')) return;
    setBusy(true);
    try { await api.disconnectLockProvider(); setDevices(null); await load(); setMsgTemp('Disconnected.'); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function loadDevices() {
    setBusy(true);
    try { const r = await api.getLockDevices(); setDevices(r.devices); setMsgTemp(`${r.devices.length} device${r.devices.length === 1 ? '' : 's'} found.`); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function syncNow() {
    setBusy(true);
    try { const r = await api.syncLocks(); await load(); setMsgTemp(`Synced ${r.updated}/${r.devices} device${r.devices === 1 ? '' : 's'}.`); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function linkDevice(unitId, deviceId, deviceName) {
    try { await api.linkLockDevice(unitId, deviceId, deviceName); await load(); setMsgTemp(deviceId ? 'Linked.' : 'Unlinked.'); }
    catch (e) { setMsg(e.message); }
  }

  const connected = provider?.connected;
  const hasCreds = provider?.hasCredentials;

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">SmartLock dashboard</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        {connected && <button className="ghost" onClick={syncNow} disabled={busy}>⟳ Sync locks</button>}
        <button className="ghost" onClick={load}>↻ Refresh</button>
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="sl-wrap">
        {/* ---- RemoteLock provider connection ---- */}
        <section className="sl-provider">
          <div className="sl-prov-head">
            <b>Smart-lock provider · RemoteLock</b>
            <span className={`sl-badge ${connected ? 'on' : hasCreds ? 'mid' : 'off'}`}>
              {connected ? '● Connected' : hasCreds ? '○ Credentials saved' : '○ Not connected'}
            </span>
          </div>

          {!connected && (
            <div className="sl-prov-body">
              <p className="muted small">
                First email <b>sales@remotelock.com</b> to enable API access on your account. Then, in the RemoteLock
                developer portal, create an <b>OAuth Application</b> — it gives you an <b>Application ID</b> and a
                <b> Secret</b>. Paste those below (not your email / login) and click Connect. No redirect needed.
              </p>
              <div className="sl-cred-row">
                <input placeholder="RemoteLock Application ID" value={cid} onChange={(e) => setCid(e.target.value)} />
                <input placeholder="RemoteLock Secret" type="password" value={csecret} onChange={(e) => setCsecret(e.target.value)} />
              </div>
              <div className="sl-connect-row">
                <button onClick={saveAndConnect} disabled={busy}>🔗 Connect with RemoteLock</button>
                <span className="muted small">Saves your credentials, opens RemoteLock to authorise, then returns here.</span>
              </div>
              {hasCreds && <div className="muted small" style={{ marginTop: 6 }}>✓ Credentials already saved — re-enter them above only if they’ve changed.</div>}
              {provider?.lastError && <div className="sl-err small">Last error: {provider.lastError}</div>}
            </div>
          )}

          {connected && (
            <div className="sl-prov-body">
              <div className="sl-connect-row">
                <button className="ghost" onClick={loadDevices} disabled={busy}>📋 List devices</button>
                <button className="ghost" onClick={disconnect} disabled={busy}>Disconnect</button>
                <span className="muted small">Last sync: {fmtWhen(provider.lastSyncAt)}</span>
              </div>
              {devices && (
                <div className="sl-devices">
                  {devices.length === 0 ? <p className="muted small">No devices returned by RemoteLock.</p> : (
                    <table className="sl-devtable">
                      <thead><tr><th>Device</th><th>Type</th><th>Battery</th><th>Status</th><th>Link to unit</th></tr></thead>
                      <tbody>
                        {devices.map((d) => (
                          <tr key={d.id}>
                            <td>{d.name}</td>
                            <td className="muted small">{d.type || '—'}</td>
                            <td>{d.battery != null ? `${d.battery}%` : '—'}</td>
                            <td>{d.online == null ? (d.status || '—') : (d.online ? 'online' : 'offline')}</td>
                            <td>
                              <select value={(units || []).find((u) => u.lockDeviceId === d.id)?.id || ''}
                                onChange={(e) => {
                                  const prev = (units || []).find((u) => u.lockDeviceId === d.id);
                                  if (prev && prev.id !== e.target.value) linkDevice(prev.id, null);
                                  if (e.target.value) linkDevice(e.target.value, d.id, d.name);
                                }}>
                                <option value="">— not linked —</option>
                                {(units || []).map((u) => <option key={u.id} value={u.id}>{u.propertyName} · {u.name}</option>)}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

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
              {!connected && <div className="sl-note muted small">Codes &amp; battery are entered manually until RemoteLock is connected above.</div>}
            </div>

            <div className="sl-grid">
              {units.map((u) => {
                const rows = detailRows(u.lockData);
                return (
                  <section key={u.id} className="sl-card">
                    <div className="sl-head">
                      <div className="sl-titles">
                        <div className="sl-unit">{u.propertyName} · {u.name}</div>
                        {u.lockDeviceId
                          ? <span className="sl-linked small">🔗 {u.lockDeviceName || 'Linked'} {u.lockSyncedAt ? `· synced ${fmtWhen(u.lockSyncedAt)}` : ''}</span>
                          : u.smartLockUrl
                            ? <a className="sl-link" href={u.smartLockUrl} target="_blank" rel="noreferrer">Open lock ↗</a>
                            : <span className="muted small">Not linked to a RemoteLock device</span>}
                      </div>
                      <label className={`sl-batt ${battClass(u.lockBattery)}`} title="Battery %">
                        🔋 <input type="number" min="0" max="100" value={u.lockBattery ?? ''} placeholder="—"
                          onChange={(e) => editBatt(u.id, e.target.value)} onBlur={(e) => persistBatt(u.id, e.target.value)} /><span className="pct">%</span>
                      </label>
                    </div>

                    {rows.length > 0 && (
                      <details className="sl-details">
                        <summary className="small">Device details from RemoteLock ({rows.length})</summary>
                        <dl className="sl-dl">
                          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
                        </dl>
                      </details>
                    )}

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
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
