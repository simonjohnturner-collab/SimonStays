import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Menu › Refer a host: this host's referral link, and who they've referred.
// They earn R1 000 when a host they referred has their first paid SimonStays
// stay; SimonStays pays it out.
const rand = (c) => `R${Math.round((c || 0) / 100).toLocaleString('en-ZA')}`;
const STATUS = { signed_up: 'Signed up · waiting for their first paid stay', earned: 'Earned · we’ll pay you shortly', paid: 'Paid ✓' };

export default function ReferView() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.myReferral().then(setD).catch((e) => setErr(e.message)); }, []);
  const copy = async () => { try { await navigator.clipboard.writeText(d.link); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { window.prompt('Copy your link:', d.link); } };
  const share = d && `https://wa.me/?text=${encodeURIComponent(`I host with SimonStays: synced calendars, guest payments, cleaner management and smart pricing, for 10% of SimonStays bookings only. Sign up here: ${d.link}`)}`;

  return (
    <div className="ref-wrap">
      <section className="sp-card ref-card">
        <h3>🤝 Refer a host, earn {d ? rand(d.rewardCents) : 'R1 000'}</h3>
        <p>Know someone with an apartment or house to let? Send them your link. When they sign up through it and take their first paid booking on SimonStays, you earn <b>{d ? rand(d.rewardCents) : 'R1 000'}</b>.</p>
        {err && <div className="msg err">{err}</div>}
        {d && d.link && (
          <>
            <div className="ref-link"><input readOnly value={d.link} onFocus={(e) => e.target.select()} /><button onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button></div>
            <a className="ref-wa" href={share} target="_blank" rel="noreferrer">Share on WhatsApp</a>
          </>
        )}
      </section>
      <section className="sp-card">
        <h4 style={{ margin: '0 0 8px' }}>Your referrals</h4>
        {!d ? <p className="muted small">Loading…</p> : !d.referrals.length ? <p className="muted small">Nobody yet. Hosts who sign up through your link appear here.</p> : (
          <table className="tr-table"><thead><tr><th>Host</th><th>Signed up</th><th>Status</th><th className="num">Reward</th></tr></thead>
            <tbody>{d.referrals.map((r, i) => (
              <tr key={i}><td>{r.name}</td><td>{new Date(r.createdAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}</td><td>{STATUS[r.status] || r.status}</td><td className="num">{rand(r.amountCents)}</td></tr>
            ))}</tbody></table>
        )}
      </section>
    </div>
  );
}
