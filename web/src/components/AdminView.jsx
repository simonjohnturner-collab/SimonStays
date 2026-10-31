import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtR } from '../money.js';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');
const fmtDay = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const fmtWhen = (d) => new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const place = (r) => [r.property, r.unit && `Unit ${r.unit}`].filter(Boolean).join(' · ') || '—';

// SimonStays admin portal (super-admin only): every host, their properties, the
// SimonStays bookings with the service fee, and guest ↔ host messages.
export default function AdminView({ onClose }) {
  const [tab, setTab] = useState('overview');
  const [hosts, setHosts] = useState(null);
  const [hostFilter, setHostFilter] = useState(''); // '' = all hosts
  const [msg, setMsg] = useState('');

  useEffect(() => { api.adminListHosts().then((r) => setHosts(r.hosts)).catch((e) => setMsg(e.message)); }, []);
  const showHost = (hostId, t) => { setHostFilter(hostId); setTab(t); };

  const HostPicker = () => (
    <select value={hostFilter} onChange={(e) => setHostFilter(e.target.value)}>
      <option value="">All hosts</option>
      {(hosts || []).map((h) => <option key={h.id} value={h.id}>{h.name || h.email}</option>)}
    </select>
  );

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Admin portal</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="msg-tabs">
        {[['overview', '📊 Overview'], ['hosts', '👥 Hosts'], ['properties', '🏠 Properties'], ['transactions', '💳 Transactions'], ['messages', '💬 Messages']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      <div className="admin-wrap">
        {tab === 'overview' && <Overview hosts={hosts} onGo={setTab} />}
        {tab === 'hosts' && <Hosts hosts={hosts} onShow={showHost} />}
        {tab === 'properties' && <Properties hostFilter={hostFilter} HostPicker={HostPicker} />}
        {tab === 'transactions' && <Transactions hostFilter={hostFilter} HostPicker={HostPicker} />}
        {tab === 'messages' && <Messages hostFilter={hostFilter} HostPicker={HostPicker} />}
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

const thisMonth = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().slice(0, 10); };

function Overview({ hosts, onGo }) {
  const [all, setAll] = useState(null);
  const [month, setMonth] = useState(null);
  useEffect(() => {
    api.adminTransactions({}).then(setAll).catch(() => {});
    api.adminTransactions({ from: thisMonth() }).then(setMonth).catch(() => {});
  }, []);
  const t = all && all.totals, m = month && month.totals;
  return (
    <>
      <div className="mk-tiles">
        <Tile label="Hosts" value={hosts ? hosts.length : '…'} sub={hosts ? `${hosts.reduce((n, h) => n + h.counts.properties, 0)} properties · ${hosts.reduce((n, h) => n + h.counts.units, 0)} units` : ''} />
        <Tile label={`SimonStays fee (${all ? all.feePercent : '…'}%)`} value={t ? fmtR(t.feeCents) : '…'} sub={m ? `${fmtR(m.feeCents)} this month` : ''} />
        <Tile label="Booked through SimonStays" value={t ? fmtR(t.grossCents) : '…'} sub={t ? `${t.bookings} confirmed booking${t.bookings === 1 ? '' : 's'}` : ''} />
        <Tile label="Owed to hosts" value={t ? fmtR(t.hostNetCents) : '…'} sub={t ? `${t.pending} awaiting payment · ${t.cancelled} cancelled` : ''} />
      </div>
      <p className="muted small">
        SimonStays keeps {all ? all.feePercent : 10}% of every confirmed booking made through SimonStays (the website and app): accommodation, cleaning and extras, not the refundable deposit.
        Airbnb and the host’s own direct bookings carry no SimonStays fee. <button className="linklike" onClick={() => onGo('transactions')}>See every transaction →</button>
      </p>
    </>
  );
}

function Hosts({ hosts, onShow }) {
  const { impersonate } = useAuth();
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState('');
  const [msg, setMsg] = useState('');

  async function signInAs(h) {
    if (!window.confirm(`Sign in as ${h.name || h.email}? You'll see their account exactly as they do until you return to your admin account.`)) return;
    setBusyId(h.id);
    try { await impersonate(h.id); } // reloads the page as that host
    catch (e) { setMsg(e.message); setBusyId(''); }
  }

  const list = (hosts || []).filter((h) => {
    const s = q.trim().toLowerCase();
    return !s || (h.email || '').toLowerCase().includes(s) || (h.name || '').toLowerCase().includes(s);
  });

  return (
    <>
      <div className="admin-tools">
        <input placeholder="Search by name or email…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted small">{msg || (hosts ? `${list.length} of ${hosts.length} host${hosts.length === 1 ? '' : 's'}` : 'Loading…')}</span>
      </div>
      {!hosts ? <p className="muted small">Loading…</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Host</th><th>Email</th><th>Phone</th><th>Joined</th>
                <th className="num">Properties</th><th className="num">Units</th><th className="num">Bookings</th>
                <th>Payout</th><th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((h) => (
                <tr key={h.id} className={h.isAdmin ? 'is-admin' : ''}>
                  <td>{h.name || <span className="muted">—</span>} {h.isAdmin && <span className="admin-tag">admin</span>}</td>
                  <td className="small">{h.email}</td>
                  <td className="small">{h.contactPhone || <span className="muted">—</span>}</td>
                  <td className="small">{fmtDate(h.createdAt)}</td>
                  <td className="num"><button className="linklike" title="Their properties" onClick={() => onShow(h.id, 'properties')}>{h.counts.properties}</button></td>
                  <td className="num">{h.counts.units}</td>
                  <td className="num">{h.counts.bookings}</td>
                  <td>{h.hasPayout ? '✅' : <span className="muted small">—</span>}</td>
                  <td className="num">
                    <button className="ghost sm" title="Their transactions" onClick={() => onShow(h.id, 'transactions')}>💳</button>{' '}
                    <button className="ghost sm" title="Their guest messages" onClick={() => onShow(h.id, 'messages')}>💬</button>{' '}
                    <button className="ghost sm" disabled={busyId === h.id} onClick={() => signInAs(h)}>
                      {busyId === h.id ? '…' : 'Sign in as →'}
                    </button>
                  </td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={9} className="muted small" style={{ padding: 16 }}>No hosts match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Properties({ hostFilter, HostPicker }) {
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.adminProperties().then((r) => setRows(r.properties)).catch((e) => setMsg(e.message)); }, []);
  const list = (rows || []).filter((p) => !hostFilter || p.hostId === hostFilter);
  return (
    <>
      <div className="admin-tools">
        <HostPicker />
        <span className="muted small">{msg || (rows ? `${list.length} propert${list.length === 1 ? 'y' : 'ies'}` : 'Loading…')}</span>
      </div>
      {rows && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Property</th><th>Host</th><th>Address</th><th>Units</th><th className="num">Bookings</th><th>Added</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.name}</b></td>
                  <td className="small">{p.host}</td>
                  <td className="small">{p.address || <span className="muted">—</span>}</td>
                  <td className="small">{p.units.length ? p.units.join(', ') : <span className="muted">none</span>}</td>
                  <td className="num">{p.bookings}</td>
                  <td className="small">{fmtDate(p.createdAt)}</td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={6} className="muted small" style={{ padding: 16 }}>No properties.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const STATUS = { confirmed: '✅ Confirmed', pending: '⏳ Awaiting payment', cancelled: '✖ Cancelled' };

function Transactions({ hostFilter, HostPicker }) {
  const [data, setData] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setData(null);
    api.adminTransactions({ hostId: hostFilter, from, to, status }).then(setData).catch((e) => setMsg(e.message));
  }, [hostFilter, from, to, status]);

  function downloadCsv() {
    const cols = ['Booked', 'Ref', 'Status', 'Host', 'Property', 'Unit', 'Guest', 'Check-in', 'Check-out', 'Method', 'Paygate transaction', 'Total (R)', 'Deposit (R)', 'Paid (R)', 'Booking value (R)', `SimonStays fee ${data.feePercent}% (R)`, 'Owed to host (R)'];
    const r = (c) => (c / 100).toFixed(2);
    const lines = data.rows.map((x) => [fmtDate(x.createdAt), x.ref, x.status, x.host, x.property, x.unit, x.guestName, x.checkIn, x.checkOut, x.method, x.paygateRef, r(x.totalCents), r(x.depositCents), r(x.paidCents), r(x.grossCents), r(x.feeCents), r(x.hostNetCents)]);
    const csv = [cols, ...lines].map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `simonstays-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  const t = data && data.totals;
  return (
    <>
      <div className="admin-tools admin-filters">
        <HostPicker />
        <label className="small">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          <option value="confirmed">Confirmed</option>
          <option value="pending">Awaiting payment</option>
          <option value="cancelled">Cancelled</option>
        </select>
        {data && data.rows.length > 0 && <button className="ghost sm" onClick={downloadCsv}>⬇ CSV</button>}
      </div>
      {msg && <p className="small">{msg}</p>}
      {!data ? <p className="muted small">Loading…</p> : (
        <>
          <div className="mk-tiles">
            <Tile label="Confirmed bookings" value={t.bookings} sub={`${t.pending} awaiting · ${t.cancelled} cancelled`} />
            <Tile label="Booking value" value={fmtR(t.grossCents)} sub="excl. deposits" />
            <Tile label={`SimonStays fee (${data.feePercent}%)`} value={fmtR(t.feeCents)} />
            <Tile label="Owed to hosts" value={fmtR(t.hostNetCents)} sub={`${fmtR(t.collectedCents)} collected from guests`} />
          </div>
          <p className="muted small">Bookings made through SimonStays, filtered by the date they were made. The fee only counts once a booking is confirmed.</p>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Booked</th><th>Guest</th><th>Stay</th><th>Host</th><th>Status</th><th>Method</th>
                  <th className="num">Paid</th><th className="num">Value</th><th className="num">Fee</th><th className="num">To host</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((x) => (
                  <tr key={x.id} className={x.status === 'cancelled' ? 'muted' : ''}>
                    <td className="small">{fmtDate(x.createdAt)}<div className="muted">{x.ref}</div></td>
                    <td className="small">{x.guestName || '—'}<div className="muted">{x.guestEmail}</div></td>
                    <td className="small">{place(x)}<div className="muted">{fmtDay(x.checkIn)} → {fmtDay(x.checkOut)}</div></td>
                    <td className="small">{x.host}</td>
                    <td className="small">{STATUS[x.status] || x.status}</td>
                    <td className="small">{x.method}{x.paygateRef && <div className="muted">#{x.paygateRef}</div>}</td>
                    <td className="num">{fmtR(x.paidCents)}</td>
                    <td className="num">{fmtR(x.grossCents)}</td>
                    <td className="num"><b>{x.feeCents ? fmtR(x.feeCents) : '—'}</b></td>
                    <td className="num">{x.hostNetCents ? fmtR(x.hostNetCents) : '—'}</td>
                  </tr>
                ))}
                {data.rows.length === 0 && <tr><td colSpan={10} className="muted small" style={{ padding: 16 }}>No SimonStays bookings match.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Messages({ hostFilter, HostPicker }) {
  const [threads, setThreads] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [thread, setThread] = useState(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setThreads(null); setActiveId(null);
    api.adminMessageThreads(hostFilter).then((r) => setThreads(r.threads)).catch((e) => setMsg(e.message));
  }, [hostFilter]);
  useEffect(() => {
    setThread(null);
    if (activeId) api.adminMessageThread(activeId).then(setThread).catch((e) => setMsg(e.message));
  }, [activeId]);

  const s = q.trim().toLowerCase();
  const list = (threads || []).filter((t) => !s || [t.guestName, t.host, t.property, t.ref].some((v) => (v || '').toLowerCase().includes(s)));
  const b = thread && thread.booking;

  return (
    <>
      <div className="admin-tools">
        <HostPicker />
        <input type="search" placeholder="Guest, property or ref…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted small">{msg || 'Read-only: opening a conversation here doesn’t mark it read.'}</span>
      </div>
      <div className={`msg-layout${activeId ? ' has-active' : ''}`}>
        <aside className="msg-list">
          {!threads ? <p className="muted small">Loading…</p> : list.length === 0 ? <p className="muted small">No conversations.</p> : list.map((t) => (
            <button key={t.bookingId} className={`msg-item${t.bookingId === activeId ? ' on' : ''}`} onClick={() => setActiveId(t.bookingId)}>
              <span className="msg-item-top"><b>{t.guestName || 'Guest'}</b><span className="muted small">{t.count}</span></span>
              <span className="muted small">{t.host} · {place(t)}</span>
              <span className="muted small">{fmtDay(t.checkIn)} → {fmtDay(t.checkOut)}</span>
              {t.last && <span className="msg-snippet small">{t.last.sender === 'host' ? 'Host: ' : 'Guest: '}{t.last.body}</span>}
            </button>
          ))}
        </aside>
        <section className="msg-thread">
          {!activeId ? <p className="muted center">Pick a conversation.</p> : !thread ? <p className="muted small">Loading…</p> : (
            <>
              <div className="msg-thread-head">
                <button className="secondary msg-back" onClick={() => setActiveId(null)}>←</button>
                <div>
                  <b>{b.guestName || 'Guest'}</b> <span className="muted small">↔ {b.host}{b.ref ? ` · ${b.ref}` : ''}</span>
                  <div className="muted small">{place(b)} · {fmtDay(b.checkIn)} → {fmtDay(b.checkOut)}</div>
                </div>
              </div>
              <div className="msg-bubbles">
                {thread.messages.map((m) => (
                  <div key={m.id} className={`msg-bubble ${m.sender}`}>
                    {m.automatic && <div className="msg-auto">⏰ Scheduled message</div>}
                    <div className="msg-body">{m.body}</div>
                    <div className="msg-meta">{m.sender === 'host' ? 'Host' : 'Guest'} · {fmtWhen(m.createdAt)}{m.readAt ? ' · Read' : ''}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
