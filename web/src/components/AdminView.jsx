import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');

export default function AdminView({ onClose }) {
  const { impersonate } = useAuth();
  const [hosts, setHosts] = useState(null);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState('');

  async function load() {
    try { const r = await api.adminListHosts(); setHosts(r.hosts); }
    catch (e) { setMsg(e.message); }
  }
  useEffect(() => { load(); }, []);

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
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Admin · all users</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={load}>↻ Refresh</button>
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="admin-wrap">
        <div className="admin-tools">
          <input placeholder="Search by name or email…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="muted small">{hosts ? `${list.length} of ${hosts.length} host${hosts.length === 1 ? '' : 's'}` : 'Loading…'}</span>
        </div>

        {!hosts ? <p className="muted small">Loading…</p> : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Host</th><th>Email</th><th>Joined</th>
                  <th className="num">Properties</th><th className="num">Units</th><th className="num">Bookings</th>
                  <th>Payout</th><th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((h) => (
                  <tr key={h.id} className={h.isAdmin ? 'is-admin' : ''}>
                    <td>{h.name || <span className="muted">—</span>} {h.isAdmin && <span className="admin-tag">admin</span>}</td>
                    <td className="small">{h.email}</td>
                    <td className="small">{fmtDate(h.createdAt)}</td>
                    <td className="num">{h.counts.properties}</td>
                    <td className="num">{h.counts.units}</td>
                    <td className="num">{h.counts.bookings}</td>
                    <td>{h.hasPayout ? '✅' : <span className="muted small">—</span>}</td>
                    <td className="num">
                      <button className="ghost sm" disabled={busyId === h.id} onClick={() => signInAs(h)}>
                        {busyId === h.id ? '…' : 'Sign in as →'}
                      </button>
                    </td>
                  </tr>
                ))}
                {list.length === 0 && <tr><td colSpan={8} className="muted small" style={{ padding: 16 }}>No hosts match.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
