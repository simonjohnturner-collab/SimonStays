import { useEffect, useState } from 'react';
import { api } from '../api.js';

const rand = (c) => (c == null ? '—' : 'R' + (Math.round(c) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const day = (d) => (d ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const toCents = (v) => (String(v).trim() === '' ? null : Math.round(Number(v) * 100));
const toRand = (c) => (c == null ? '' : String(c / 100));

// Platform admin › Township Stays: the fees (defaults + per-listing overrides),
// every Township host's plan and credit, and credit or months added by hand.
export default function AdminTownship() {
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [fees, setFees] = useState({ monthly: '', click: '' });
  const [edits, setEdits] = useState({}); // listing id -> { monthly, click }

  async function load() {
    try {
      const r = await api.adminTownship(); setD(r);
      setFees({ monthly: toRand(r.settings.monthlyFeeCents), click: toRand(r.settings.clickFeeCents) });
      setEdits(Object.fromEntries(r.listings.map((l) => [l.id, { monthly: toRand(l.tsMonthlyFeeCents), click: toRand(l.tsClickFeeCents) }])));
    } catch (e) { setMsg(e.message); }
  }
  useEffect(() => { load(); }, []);
  async function run(fn, done) { setMsg(''); try { await fn(); setMsg(done); await load(); } catch (e) { setMsg(e.message); } }

  if (!d) return <p className="muted small">{msg || 'Loading…'}</p>;

  return (
    <div className="ts-body" style={{ padding: 0, maxWidth: 'none' }}>
      {msg && <div className="small">{msg}</div>}
      <div className="ts-card">
        <div className="ts-head"><b>Fees</b><span className="muted small">The default for every Township listing. Override one listing below.</span></div>
        <div className="ts-row">
          <span className="muted small">Monthly fee per listing R</span>
          <input className="ts-amt" inputMode="decimal" value={fees.monthly} onChange={(e) => setFees({ ...fees, monthly: e.target.value })} />
          <span className="muted small">Fee per click R</span>
          <input className="ts-amt" inputMode="decimal" value={fees.click} onChange={(e) => setFees({ ...fees, click: e.target.value })} />
          <button onClick={() => run(() => api.adminTownshipSettings({ monthlyFeeCents: toCents(fees.monthly) ?? 0, clickFeeCents: toCents(fees.click) ?? 0 }), 'Fees saved.')}>Save fees</button>
        </div>
      </div>

      <div className="ts-card">
        <div className="ts-head"><b>Hosts</b></div>
        {!d.hosts.length ? <p className="muted small">No Township hosts yet.</p> : (
          <table className="ts-table">
            <thead><tr><th>Host</th><th>Plan</th><th>Credit</th><th>Spent this month</th><th>Leads this month</th><th>Waiting</th><th></th></tr></thead>
            <tbody>
              {d.hosts.map((h) => (
                <tr key={h.id}>
                  <td><b>{h.name || h.email}</b><div className="muted small">{h.email}{h.cardLabel ? ` · ${h.cardLabel}` : ''}</div></td>
                  <td>{h.plan === 'monthly' ? 'Monthly' : h.plan === 'click' ? 'Per click' : 'None yet'}</td>
                  <td>{rand(h.creditCents)}</td>
                  <td>{rand(h.spentThisMonthCents)}</td>
                  <td>{h.leadsThisMonth}</td>
                  <td>{h.lockedLeads || ''}</td>
                  <td><button className="mini" onClick={() => {
                    const v = window.prompt(`Add credit for ${h.name || h.email} (rand, negative to take off):`, '100');
                    if (v == null || !Number(v)) return;
                    const note = window.prompt('Note (e.g. Paid by EFT, ref …)', 'Paid by EFT') || '';
                    run(() => api.adminTownshipCredit(h.id, Math.round(Number(v) * 100), note), 'Credit added.');
                  }}>Add credit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="ts-card">
        <div className="ts-head"><b>Listings</b><span className="muted small">Blank fee = the default</span></div>
        {!d.listings.length ? <p className="muted small">No Township listings yet.</p> : (
          <table className="ts-table">
            <thead><tr><th>Listing</th><th>Status</th><th>Monthly fee R</th><th>Click fee R</th><th>Paid until</th><th></th></tr></thead>
            <tbody>
              {d.listings.map((l) => {
                const e = edits[l.id] || { monthly: '', click: '' };
                const set = (patch) => setEdits({ ...edits, [l.id]: { ...e, ...patch } });
                return (
                  <tr key={l.id}>
                    <td><b>{l.name}</b><div className="muted small">{l.hostName}{l.areaName ? ` · ${l.areaName}` : ''} · {l.leads} lead{l.leads === 1 ? '' : 's'}</div></td>
                    <td>{l.hidden ? 'Hidden' : l.live ? 'Live' : <span title={l.missing.join(', ')}>Not live</span>}</td>
                    <td><input className="ts-amt" style={{ width: 80 }} placeholder={toRand(d.settings.monthlyFeeCents)} value={e.monthly} onChange={(ev) => set({ monthly: ev.target.value })} /></td>
                    <td><input className="ts-amt" style={{ width: 80 }} placeholder={toRand(d.settings.clickFeeCents)} value={e.click} onChange={(ev) => set({ click: ev.target.value })} /></td>
                    <td>{day(l.paidUntil)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="mini" onClick={() => run(() => api.adminTownshipListing(l.id, { tsMonthlyFeeCents: toCents(e.monthly), tsClickFeeCents: toCents(e.click) }), 'Listing fees saved.')}>Save</button>{' '}
                      <button className="mini" title="Add a month, paid by EFT or free" onClick={() => {
                        const note = window.prompt('Mark a month paid. Note (e.g. Paid by EFT):', 'Paid by EFT');
                        if (note != null) run(() => api.adminTownshipMonth(l.id, note), 'Month added.');
                      }}>+1 month</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {d.payments.length > 0 && (
        <div className="ts-card">
          <div className="ts-head"><b>Payments</b></div>
          <table className="ts-table">
            <thead><tr><th>When</th><th>Host</th><th>What</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {d.payments.map((p) => (
                <tr key={p.id}><td>{day(p.createdAt)}</td><td>{p.host}</td><td>{p.kind === 'topup' ? 'Top-up' : `${p.months || 1} month${(p.months || 1) === 1 ? '' : 's'}`} · {p.method}{p.note ? <div className="muted small">{p.note}</div> : ''}</td><td>{rand(p.amountCents)}</td><td>{p.status}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
