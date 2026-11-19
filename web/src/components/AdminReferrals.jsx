import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Platform admin › Referrals: who referred which new host, and the R1 000 owed
// once that host's first paid SimonStays stay is over. Pay it, then mark it paid.
const rand = (c) => `R${Math.round((c || 0) / 100).toLocaleString('en-ZA')}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const LABEL = { signed_up: 'Waiting for first paid stay', earned: 'To pay', paid: 'Paid' };
const person = (p) => (p ? <>{p.name || p.email}<div className="muted">{[p.email, p.phone].filter(Boolean).join(' · ')}</div></> : '—');

export default function AdminReferrals() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.adminReferrals().then((d) => setRows(d.referrals)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const toggle = async (r) => {
    if (r.status === 'earned' && !window.confirm(`Mark ${rand(r.amountCents)} as paid to ${r.referrer ? r.referrer.name || r.referrer.email : 'the referrer'}?`)) return;
    try { await api.markReferralPaid(r.id); load(); } catch (e) { setErr(e.message); }
  };
  if (err) return <div className="msg err">{err}</div>;
  if (!rows) return <p className="muted small">Loading…</p>;
  const owed = rows.filter((r) => r.status === 'earned').reduce((n, r) => n + r.amountCents, 0);
  return (
    <>
      <p className="muted small">A referrer earns their reward once the host they referred has a paid SimonStays stay that’s over. Pay it by EFT, then mark it paid. {owed ? <b>To pay now: {rand(owed)}</b> : null}</p>
      {!rows.length ? <p className="muted">No referrals yet.</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>New host</th><th>Referred by</th><th>Signed up</th><th>Status</th><th className="num">Reward</th><th></th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td className="small">{person(r.referred)}</td>
                <td className="small">{person(r.referrer)}<div className="muted">{r.referrerKind === 'host' ? 'Host' : 'Guest'} · code {r.code}</div></td>
                <td className="small">{day(r.createdAt)}</td>
                <td className="small"><span className={`ref-st ${r.status}`}>{LABEL[r.status] || r.status}</span>{r.paidAt ? <div className="muted">{day(r.paidAt)}</div> : r.earnedAt ? <div className="muted">earned {day(r.earnedAt)}</div> : null}</td>
                <td className="num">{rand(r.amountCents)}</td>
                <td>{r.status !== 'signed_up' && <button className="ghost sm" onClick={() => toggle(r)}>{r.status === 'paid' ? 'Undo' : 'Mark paid'}</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
