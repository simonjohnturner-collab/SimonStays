import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { navigate } from '../router.js';

const rand = (c) => 'R' + (Math.round(c || 0) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => (d ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const when = (d) => new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Hosting › Township Stays: the host's plan (monthly fee or pay per click), credit,
// monthly maximum, listing fees and the tenants who asked for their contact details.
export default function TownshipView() {
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [topup, setTopup] = useState('250');
  const [cap, setCap] = useState('');

  async function load() {
    try { const r = await api.township(); setD(r); setCap(r.monthlyCapCents == null ? '' : String(r.monthlyCapCents / 100)); }
    catch (e) { setMsg(e.message); }
  }
  useEffect(() => {
    load();
    const q = new URLSearchParams(window.location.search);
    if (q.get('paid')) setMsg('Payment received. Thank you!');
    if (q.get('payment') === 'cancelled') setMsg('The payment was not completed. Nothing was charged.');
    if (q.get('paid') || q.get('payment')) navigate('/listings/township', { replace: true });
  }, []);

  async function run(fn, done) {
    setBusy(true); setMsg('');
    try { await fn(); if (done) setMsg(done); await load(); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }
  // Paygate: go to the secure payment page (or, in test mode, it's applied at once).
  async function pay(start) {
    setBusy(true); setMsg('');
    try {
      const r = await start();
      if (r.mode === 'form' && r.goUrl) { window.location.href = r.goUrl; return; }
      setMsg('Payment applied (test mode: no card was charged).');
      await load();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }

  if (!d) return <div className="invoices-view"><p className="muted small" style={{ padding: 16 }}>{msg || 'Loading…'}</p></div>;

  const monthlyTotal = d.listings.filter((l) => !l.hidden).reduce((a, l) => a + l.monthlyFeeCents, 0);
  const clickFee = d.listings.length ? Math.min(...d.listings.map((l) => l.clickFeeCents)) : d.fees.clickFeeCents;

  return (
    <div className="invoices-view township-view">
      <header className="topbar">
        <span className="host">Township Stays</span>
        <div className="spacer" />
        {msg && <span className="small">{msg}</span>}
      </header>

      <div className="ts-body">
        {!d.listings.length && (
          <div className="ts-card">
            <b>List your first Township Stay</b>
            <p className="muted small">Add a room or home to rent on SimonStays Township Stays: photos, the area, the place and the rent.</p>
            <button onClick={() => navigate('/listings')}>Go to Listings</button>
          </div>
        )}

        <div className="ts-card">
          <div className="ts-head"><b>Your plan</b>
            {d.plan && <span className={`ts-pill ${d.clicksOpen ? 'ok' : 'off'}`}>{d.clicksOpen ? 'Contact button on' : 'Contact button off'}</span>}
          </div>
          <div className="ts-plans">
            <label className={`ts-plan ${d.plan === 'monthly' ? 'on' : ''}`}>
              <input type="radio" name="tsplan" checked={d.plan === 'monthly'} disabled={busy} onChange={() => run(() => api.townshipPlan({ plan: 'monthly' }), 'Plan changed to monthly.')} />
              <span><b>Monthly</b><span className="muted small">{rand(d.fees.monthlyFeeCents)} per listing per month. Tenants see your contact details for free.</span></span>
            </label>
            <label className={`ts-plan ${d.plan === 'click' ? 'on' : ''}`}>
              <input type="radio" name="tsplan" checked={d.plan === 'click'} disabled={busy} onChange={() => run(() => api.townshipPlan({ plan: 'click' }), 'Plan changed to pay per click.')} />
              <span><b>Pay per click</b><span className="muted small">{rand(clickFee)} each time a tenant asks for your contact details, from credit you load. Each tenant is charged once per listing every 30 days.</span></span>
            </label>
          </div>
        </div>

        {d.plan === 'click' && (
          <div className="ts-card">
            <div className="ts-head"><b>Credit</b><span className="ts-big">{rand(d.creditCents)}</span></div>
            <div className="ts-row">
              <span className="muted small">Top up</span>
              {['100', '250', '500'].map((v) => <button key={v} className={topup === v ? '' : 'secondary'} onClick={() => setTopup(v)}>R{v}</button>)}
              <input className="ts-amt" inputMode="decimal" value={topup} onChange={(e) => setTopup(e.target.value.replace(/[^0-9.]/g, ''))} />
              <button disabled={busy || !(Number(topup) >= 50)} onClick={() => pay(() => api.townshipTopup(Math.round(Number(topup) * 100)))}>Pay R{topup || 0}</button>
            </div>
            <p className="muted small">Minimum R50. You pay on Paygate’s secure page.</p>
            <div className="ts-row" style={{ marginTop: 10 }}>
              <span className="muted small">Monthly maximum</span>
              <input className="ts-amt" inputMode="decimal" placeholder="No limit" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ''))} />
              <button className="secondary" disabled={busy} onClick={() => run(() => api.townshipPlan({ monthlyCapCents: cap === '' ? null : Math.round(Number(cap) * 100) }), 'Monthly maximum saved.')}>Save</button>
            </div>
            <p className="muted small">Spent this month: {rand(d.spentThisMonthCents)}{d.monthlyCapCents != null ? ` of ${rand(d.monthlyCapCents)}` : ''}. When your credit runs out or you reach your maximum, the Contact button switches off. Tenants can still ask you to contact them, and their details unlock when you top up.</p>
          </div>
        )}

        {d.plan === 'monthly' && (
          <div className="ts-card">
            <div className="ts-head"><b>Monthly fees</b>{d.cardLabel && <span className="muted small">Saved card: {d.cardLabel}</span>}</div>
            <table className="ts-table">
              <thead><tr><th>Listing</th><th>Fee</th><th>Paid until</th></tr></thead>
              <tbody>
                {d.listings.map((l) => (
                  <tr key={l.id}><td>{l.name}{l.hidden ? <span className="muted small"> (hidden)</span> : ''}</td><td>{rand(l.monthlyFeeCents)}</td><td>{day(l.paidUntil)}</td></tr>
                ))}
              </tbody>
            </table>
            {d.listings.some((l) => !l.hidden) && (
              <button style={{ marginTop: 10 }} disabled={busy || !monthlyTotal} onClick={() => pay(() => api.townshipPayMonth())}>Pay a month: {rand(monthlyTotal)}</button>
            )}
            <p className="muted small">{d.cardSaving
              ? 'Your card is saved when you pay and charged automatically each month. We email you before it renews.'
              : 'Each month adds a month from the day your current month ends. We email you 3 days before a listing comes off.'}</p>
          </div>
        )}

        {d.listings.length > 0 && (
          <div className="ts-card">
            <div className="ts-head"><b>Your listings</b><a onClick={() => navigate('/listings')}>Edit in Listings →</a></div>
            <ul className="ts-list">
              {d.listings.map((l) => (
                <li key={l.id}>
                  <b>{l.name}</b>{l.areaName ? <span className="muted small"> · {l.areaName}</span> : ''}
                  <span className={`ts-pill ${l.live ? 'ok' : 'off'}`}>{l.hidden ? 'Hidden' : l.live ? 'Live' : 'Not live'}</span>
                  {!l.live && !l.hidden && l.missing.length > 0 && <div className="muted small">Still needs {l.missing.join(', ')}.</div>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="ts-card">
          <div className="ts-head"><b>Leads</b><span className="muted small">Tenants who asked for your contact details</span></div>
          {d.lockedCount > 0 && <div className="ts-locked">{d.lockedCount} tenant{d.lockedCount === 1 ? ' is' : 's are'} waiting for you to contact them. Their details unlock when you top up{d.monthlyCapCents != null ? ' or raise your maximum' : ''}.</div>}
          {!d.leads.length ? <p className="muted small">No leads yet.</p> : (
            <table className="ts-table">
              <thead><tr><th>When</th><th>Listing</th><th>Tenant</th><th>Cost</th></tr></thead>
              <tbody>
                {d.leads.map((l) => (
                  <tr key={l.id} className={l.status === 'locked' ? 'locked' : ''}>
                    <td>{when(l.createdAt)}</td>
                    <td>{l.propertyName}</td>
                    <td>{l.status === 'locked' ? <span className="muted">Locked until you top up</span> : <>
                      <b>{l.name || 'Tenant'}</b>
                      {l.phone && <> · <a href={`tel:${l.phone}`}>{l.phone}</a></>}
                      {l.email && <> · <a href={`mailto:${l.email}`}>{l.email}</a></>}
                      {l.message && <div className="muted small">“{l.message}”</div>}
                    </>}</td>
                    <td>{l.status === 'locked' ? '—' : l.feeCents ? rand(l.feeCents) : 'Free'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {d.payments.length > 0 && (
          <div className="ts-card">
            <div className="ts-head"><b>Payments</b></div>
            <table className="ts-table">
              <thead><tr><th>When</th><th>What</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {d.payments.map((p) => (
                  <tr key={p.id}><td>{when(p.createdAt)}</td><td>{p.kind === 'topup' ? 'Credit top-up' : 'Monthly fee'}{p.method === 'admin' ? ' (by SimonStays)' : p.method === 'vault' ? ' (saved card)' : ''}</td>
                    <td>{rand(p.amountCents)}</td><td>{p.status === 'COMPLETE' ? 'Paid' : p.status === 'pending' ? 'Not completed' : p.status.toLowerCase().replace('_', ' ')}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
