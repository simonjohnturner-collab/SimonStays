import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { navigate } from '../router.js';

const rand = (c) => 'R' + (Math.round(c || 0) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => (d ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const when = (d) => new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Hosting › Township Stays: the host's plan (months paid upfront, or pay per click),
// credit, paid months per listing and the tenants who asked for their contact details.
export default function TownshipView() {
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [topup, setTopup] = useState('250');
  const [months, setMonths] = useState({}); // listing id → months typed in

  async function load() {
    try { setD(await api.township()); }
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
              <span><b>Pay for months</b><span className="muted small">{rand(d.fees.monthlyFeeCents)} per listing per month. Pay upfront for as many months as you like. Tenants see your contact details for free while it's paid.</span></span>
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
            <p className="muted small">Minimum R50. You pay on Paygate’s secure page. Your credit works for all your listings.</p>
            <p className="muted small">When your credit runs out, the Contact button switches off but your listings stay up. Tenants can still ask you to contact them: we let you know, and their details unlock when you top up. If a place has been rented, remove it so you stop getting these messages.</p>
          </div>
        )}

        {d.plan === 'monthly' && (
          <div className="ts-card">
            <div className="ts-head"><b>Paid months</b></div>
            <table className="ts-table">
              <thead><tr><th>Listing</th><th>Paid until</th><th>Pay for more</th></tr></thead>
              <tbody>
                {d.listings.map((l) => {
                  const n = months[l.id] ?? '1';
                  const ok = Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 60;
                  return (
                    <tr key={l.id}>
                      <td>{l.name}{l.hidden ? <span className="muted small"> (removed)</span> : ''}<div className="muted small">{rand(l.monthlyFeeCents)} a month</div></td>
                      <td>{l.paidUntil ? day(l.paidUntil) : 'Not paid yet'}{l.paidUntil && !l.paid && <div className="muted small">Ended: tenants can’t see your details</div>}</td>
                      <td>
                        <div className="ts-row" style={{ margin: 0 }}>
                          <input className="ts-amt" style={{ width: 56 }} inputMode="numeric" value={n} onChange={(e) => setMonths((m) => ({ ...m, [l.id]: e.target.value.replace(/[^0-9]/g, '') }))} />
                          <span className="muted small">month{n === '1' ? '' : 's'}</span>
                          <button disabled={busy || !ok || l.hidden} onClick={() => pay(() => api.townshipPayMonths(l.id, Number(n)))}>Pay {ok ? rand(l.monthlyFeeCents * Number(n)) : ''}</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted small">Months are added on from the day the current paid time ends. Nothing is charged automatically: we remind you by email and WhatsApp 3 days before and on the day it ends.</p>
            <p className="muted small">After that your listing stays up, but tenants can’t see your contact details. We let you know when someone is interested, and their details unlock when you pay for more months. If a place has been rented, remove it so you stop getting these messages. No refunds for unused months.</p>
          </div>
        )}

        {d.listings.length > 0 && (
          <div className="ts-card">
            <div className="ts-head"><b>Your listings</b><a onClick={() => navigate('/listings')}>Edit in Listings →</a></div>
            <ul className="ts-list">
              {d.listings.map((l) => (
                <li key={l.id}>
                  <b>{l.name}</b>{l.areaName ? <span className="muted small"> · {l.areaName}</span> : ''}
                  <span className={`ts-pill ${l.live ? 'ok' : 'off'}`}>{l.hidden ? 'Removed' : l.live ? 'Live' : 'Not live'}</span>
                  {l.availableFrom && <span className="muted small"> · Available from {day(l.availableFrom)}</span>}
                  {!l.live && !l.hidden && l.missing.length > 0 && <div className="muted small">Still needs {l.missing.join(', ')}.</div>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="ts-card">
          <div className="ts-head"><b>Leads</b><span className="muted small">Tenants who asked for your contact details</span></div>
          {d.lockedCount > 0 && <div className="ts-locked">{d.lockedCount} tenant{d.lockedCount === 1 ? ' is' : 's are'} waiting for you to contact them. Their details unlock when you {d.plan === 'monthly' ? 'pay for more months' : 'top up'}.</div>}
          {!d.leads.length ? <p className="muted small">No leads yet.</p> : (
            <table className="ts-table">
              <thead><tr><th>When</th><th>Listing</th><th>Tenant</th><th>Cost</th></tr></thead>
              <tbody>
                {d.leads.map((l) => (
                  <tr key={l.id} className={l.status === 'locked' ? 'locked' : ''}>
                    <td>{when(l.createdAt)}</td>
                    <td>{l.propertyName}</td>
                    <td>{l.status === 'locked' ? <span className="muted">Locked until you {d.plan === 'monthly' ? 'pay for more months' : 'top up'}</span> : <>
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
                  <tr key={p.id}><td>{when(p.createdAt)}</td><td>{p.kind === 'topup' ? 'Credit top-up' : `${p.months || 1} month${(p.months || 1) === 1 ? '' : 's'}${(p.propertyIds || []).length === 1 ? ': ' + ((d.listings.find((l) => l.id === p.propertyIds[0]) || {}).name || 'listing') : ''}`}{p.method === 'admin' ? ' (by SimonStays)' : ''}</td>
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
