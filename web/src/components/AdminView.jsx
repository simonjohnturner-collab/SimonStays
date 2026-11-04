import { Fragment, useEffect, useState } from 'react';
import { api, guestDocumentFile } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtR } from '../money.js';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');
const fmtDay = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const fmtWhen = (d) => new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const place = (r) => [r.property, r.unit && `Unit ${r.unit}`].filter(Boolean).join(' · ') || '—';

// SimonStays admin portal (super-admin only): every host and guest, their properties, the
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
        {[['overview', '📊 Overview'], ['hosts', '👥 Hosts'], ['guests', '🧳 Guests'], ['properties', '🏠 Properties'], ['transactions', '💳 Transactions'], ['messages', '💬 Messages']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      <div className="admin-wrap">
        {tab === 'overview' && <Overview hosts={hosts} onGo={setTab} />}
        {tab === 'hosts' && <Hosts hosts={hosts} onShow={showHost} />}
        {tab === 'guests' && <Guests hostFilter={hostFilter} HostPicker={HostPicker} />}
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
                    <button className="ghost sm" title="Their guests" onClick={() => onShow(h.id, 'guests')}>🧳</button>{' '}
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

// A guest's private file, fetched with the admin's token and released when it's done with.
function useGuestFile(accountId, kind) {
  const [state, setState] = useState({ file: null, error: '' });
  useEffect(() => {
    let live = true;
    let made = null;
    setState({ file: null, error: '' });
    guestDocumentFile(accountId, kind)
      .then((f) => { if (live) { made = f.url; setState({ file: f, error: '' }); } else URL.revokeObjectURL(f.url); })
      .catch((e) => { if (live) setState({ file: null, error: e.message }); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [accountId, kind]);
  return state;
}

// Shows a guest's picture or ID over the page. Esc or a click outside closes it.
function GuestDocViewer({ accountId, kind, name, onClose }) {
  const { file, error } = useGuestFile(accountId, kind);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const label = `${kind === 'id' ? 'ID' : 'Profile picture'} of ${name || 'guest'}`;
  return (
    <div className="overlay guest-doc-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="guest-doc" role="dialog" aria-modal="true" aria-label={label}>
        <div className="modal-head"><h3>{label}</h3><button type="button" className="secondary small" onClick={onClose}>Close</button></div>
        {error && <p className="small">{error}</p>}
        {!error && !file && <p className="muted small">Loading…</p>}
        {file && (file.type === 'application/pdf'
          ? <iframe src={`${file.url}#toolbar=0`} title={label} />
          : <img src={file.url} alt={label} />)}
      </div>
    </div>
  );
}

// A guest's profile picture: hover to enlarge it, click to open it.
function GuestPhoto({ accountId, name, onView }) {
  const { file } = useGuestFile(accountId, 'photo');
  const [hover, setHover] = useState(null);
  if (!file) return <span className="guest-avatar" />;
  const alt = `Profile picture of ${name || 'guest'}`;
  const show = (e) => { const r = e.currentTarget.getBoundingClientRect(); setHover({ left: r.right + 8, top: Math.max(8, Math.min(r.top - 40, window.innerHeight - 248)) }); };
  return (
    <>
      <button type="button" className="guest-avatar" aria-label={`View ${alt.toLowerCase()}`} onMouseEnter={show} onMouseLeave={() => setHover(null)} onFocus={show} onBlur={() => setHover(null)} onClick={() => { setHover(null); onView('photo'); }}>
        <img src={file.url} alt={alt} />
      </button>
      {hover && <img className="guest-hover" src={file.url} alt="" style={hover} />}
    </>
  );
}

// A guest's picture and ID, or why there are none. `g` has accountId, hasPhoto and hasId.
function GuestIdLink({ g, onView }) {
  if (!g.accountId) return <div className="muted">No account, so no ID</div>;
  if (!g.hasId) return <div className="muted">No ID on file</div>;
  return <div><button type="button" className="tx-link" onClick={() => onView('id')}>🪪 View ID</button></div>;
}

function Guests({ hostFilter, HostPicker }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const [msg, setMsg] = useState('');
  const [viewing, setViewing] = useState(null); // { accountId, kind, name }

  useEffect(() => {
    setData(null); setOpenKey(null);
    api.adminGuests(hostFilter).then(setData).catch((e) => setMsg(e.message));
  }, [hostFilter]);

  const s = q.trim().toLowerCase();
  const list = ((data && data.guests) || []).filter((g) => !s || [g.name, g.email, g.phone].some((v) => (v || '').toLowerCase().includes(s)));
  const t = data && data.totals;

  return (
    <>
      <div className="admin-tools">
        <HostPicker />
        <input type="search" placeholder="Search by name, email or phone…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted small">{msg || (data ? `${list.length} of ${t.guests} guest${t.guests === 1 ? '' : 's'}` : 'Loading…')}</span>
      </div>
      {viewing && <GuestDocViewer {...viewing} onClose={() => setViewing(null)} />}
      {data && (
        <>
          <div className="mk-tiles">
            <Tile label="Guests" value={t.guests} sub={`${t.accounts} with an account`} />
            <Tile label="Staying soon" value={t.staying} sub="confirmed stay ahead" />
            <Tile label="Repeat guests" value={t.repeat} sub="2+ confirmed bookings" />
            <Tile label="Awaiting payment" value={t.pending} sub="guests with an unpaid booking" />
          </div>
          <p className="muted small">People with a SimonStays account, or who booked or enquired on the website or app. Airbnb and the host’s own direct bookings aren’t listed. Value counts confirmed bookings, excluding deposits.</p>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Guest</th><th>Phone</th><th>Account</th><th>Host</th><th>Next or last stay</th>
                  <th className="num">Confirmed</th><th className="num">Awaiting</th><th className="num">Cancelled</th><th className="num">Enquiries</th>
                  <th className="num">Paid</th><th className="num">Value</th><th>Last active</th>
                </tr>
              </thead>
              <tbody>
                {list.map((g) => {
                  const stay = g.nextStay || g.lastStay;
                  return (
                    <Fragment key={g.key}>
                      <tr>
                        <td className="small guest-cell">
                          {g.hasPhoto && <GuestPhoto accountId={g.accountId} name={g.name} onView={(kind) => setViewing({ accountId: g.accountId, kind, name: g.name })} />}
                          <button className="linklike" disabled={!g.stays.length} title={g.stays.length ? 'Show their bookings' : 'No bookings yet'} onClick={() => setOpenKey(openKey === g.key ? null : g.key)}>
                            {g.stays.length ? (openKey === g.key ? '▾ ' : '▸ ') : ''}{g.name || 'Guest'}
                          </button>
                          <div className="muted">{g.email}</div>
                        </td>
                        <td className="small">{g.phone || <span className="muted">—</span>}</td>
                        <td className="small">
                          {g.hasAccount ? `✅ ${fmtDate(g.joinedAt)}` : <span className="muted">—</span>}
                          <GuestIdLink g={g} onView={(kind) => setViewing({ accountId: g.accountId, kind, name: g.name })} />
                        </td>
                        <td className="small">{g.hosts.join(', ') || <span className="muted">—</span>}</td>
                        <td className="small">
                          {stay ? <>{place(stay)}<div className="muted">{g.nextStay ? 'Next: ' : 'Last: '}{fmtDay(stay.checkIn)} → {fmtDay(stay.checkOut)}</div></> : <span className="muted">—</span>}
                        </td>
                        <td className="num">{g.counts.confirmed}</td>
                        <td className="num">{g.counts.pending}</td>
                        <td className="num">{g.counts.cancelled}</td>
                        <td className="num">{g.counts.enquiries}</td>
                        <td className="num">{fmtR(g.paidCents)}</td>
                        <td className="num"><b>{fmtR(g.valueCents)}</b></td>
                        <td className="small">{fmtDate(g.lastActivity)}</td>
                      </tr>
                      {openKey === g.key && (
                        <tr>
                          <td colSpan={12} style={{ background: '#fafafa' }}>
                            <table className="admin-table">
                              <thead>
                                <tr><th>Booked</th><th>Ref</th><th>Stay</th><th>Host</th><th>Status</th><th className="num">Paid</th><th className="num">Value</th></tr>
                              </thead>
                              <tbody>
                                {g.stays.map((x) => (
                                  <tr key={x.id} className={x.status === 'cancelled' ? 'muted' : ''}>
                                    <td className="small">{fmtDate(x.createdAt)}</td>
                                    <td className="small">{x.ref || '—'}</td>
                                    <td className="small">{place(x)}<div className="muted">{fmtDay(x.checkIn)} → {fmtDay(x.checkOut)}</div></td>
                                    <td className="small">{x.host}</td>
                                    <td className="small">{STATUS[x.status] || x.status}</td>
                                    <td className="num">{fmtR(x.paidCents)}</td>
                                    <td className="num">{fmtR(x.grossCents)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {list.length === 0 && <tr><td colSpan={12} className="muted small" style={{ padding: 16 }}>No guests match.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
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

const STATUS = { confirmed: '✅ Confirmed', pending: '⏳ Awaiting payment', cancelled: '✖ Cancelled', enquiry: '💬 Enquiry' };

const fmtFullDay = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
// Why a night cost what it did.
const nightNote = (n) => (n.overridden ? 'Price set by hand' : [n.weekend && 'Weekend rate', n.flexPercent > 0 && `+${n.flexPercent}% seasonal`].filter(Boolean).join(', '));

// The summary shown when hovering over a transaction's receipt icon.
const breakdownSummary = (tx) => [
  ...tx.breakdown.lines.map((l) => `${l.description}: ${fmtR(l.amountCents)}`),
  `Total: ${fmtR(tx.breakdown.totalCents)}`,
  `Paid: ${fmtR(tx.paidCents)}`,
  '',
  'Click for the full breakdown',
].join('\n');

// Email the guest everything about their booking. Goes only when the admin confirms.
function EmailDetails({ tx }) {
  const [sentAt, setSentAt] = useState(tx.detailsEmailedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function send() {
    const again = sentAt ? ` They were last sent one on ${fmtWhen(sentAt)}.` : '';
    if (!window.confirm(`Email ${tx.guestName || 'this guest'} at ${tx.guestEmail} their invoice, with a link to their messages?${again}`)) return;
    setBusy(true); setError('');
    try { const r = await api.adminEmailDetails(tx.id); setSentAt(r.detailsEmailedAt); }
    catch (e) { setError((e.data && e.data.message) || e.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="tx-email">
      <button type="button" className="secondary small" disabled={busy} onClick={send}>{busy ? 'Sending…' : '✉️ Email guest their invoice'}</button>
      {sentAt && <div className="muted small">Last sent {fmtWhen(sentAt)}</div>}
      {error && <div className="msg-warn">{error}</div>}
    </div>
  );
}

// The rubber stamp on a paper invoice.
function paperStamp(tx) {
  if (tx.status === 'cancelled') return { text: 'CANCELLED', cls: 'red' };
  if (tx.paidCents > 0 && tx.owingCents > 0) return { text: 'PART PAID', cls: 'red' };
  if (tx.paidCents > 0) return { text: 'PAID', cls: '' };
  return { text: 'UNPAID', cls: 'red' };
}

// How a transaction's amount came about, opened from its receipt icon.
function PaymentBreakdown({ tx }) {
  const [viewing, setViewing] = useState(null);
  const row = (label, cents, cls) => <tr key={label} className={cls}><td>{label}</td><td className="num">{fmtR(cents)}</td></tr>;
  const line = (l, i) => (
    <Fragment key={i}>
      <tr><td>{l.description}</td><td className="num">{fmtR(l.amountCents)}</td></tr>
      {(l.nights || []).map((n) => (
        <tr key={n.date} className="paper-night"><td>{fmtFullDay(n.date)}{nightNote(n) ? ` (${nightNote(n).toLowerCase()})` : ''}</td><td className="num">{fmtR(n.cents)}</td></tr>
      ))}
    </Fragment>
  );
  const stamp = paperStamp(tx);
  return (
    <div className="tx-breakdown">
      {viewing && <GuestDocViewer accountId={tx.accountId} kind={viewing} name={tx.guestName} onClose={() => setViewing(null)} />}
      <div>
        <h4>The stay</h4>
        <dl className="tx-stay">
          <dt>Where</dt><dd>{place(tx)}</dd>
          <dt>Guest</dt>
          <dd className="tx-guest">
            {tx.hasPhoto && <GuestPhoto accountId={tx.accountId} name={tx.guestName} onView={setViewing} />}
            {tx.guestName || '—'}
            <GuestIdLink g={tx} onView={setViewing} />
          </dd>
          <dt>Check-in</dt><dd>{fmtFullDay(tx.checkIn)} from {tx.checkInTime}{tx.earlyCheckIn ? ' · early check-in' : ''}</dd>
          {!tx.dayUse && <><dt>Check-out</dt><dd>{fmtFullDay(tx.checkOut)} by {tx.checkOutTime}{tx.lateCheckOut ? ' · late checkout' : ''}</dd></>}
          <dt>Paid by</dt><dd>{tx.method}{tx.paygateRef ? ` · Paygate #${tx.paygateRef}` : ''}</dd>
        </dl>
        {tx.sharedInvoice && <p className="muted small">This invoice covers several units and was paid on its first booking.</p>}
        {tx.canEmailDetails && <EmailDetails key={tx.id} tx={tx} />}
      </div>
      <div>
        <div className="paper">
          <header className="paper-head">
            <div>
              <div className="paper-brand">SimonStays</div>
              <div>support@simonstays.co.za</div>
              <div>078 511 9336</div>
            </div>
            <div className="paper-no">
              <div className="paper-title">INVOICE</div>
              <div>No. {tx.ref || '—'}</div>
              <div>Date: {fmtDate(tx.createdAt)}</div>
            </div>
          </header>
          <div className="paper-to">
            <div><span>Bill to:</span> {tx.guestName || '—'}</div>
            <div><span>For:</span> {place(tx)}</div>
            <div><span>Stay:</span> {tx.dayUse ? fmtFullDay(tx.checkIn) : `${fmtFullDay(tx.checkIn)} to ${fmtFullDay(tx.checkOut)}`}</div>
          </div>
          <table className="paper-lines">
            <thead><tr><th>Description</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {tx.breakdown.lines.map(line)}
              {tx.changes.map((c) => (
                <Fragment key={c.id}>
                  <tr className="paper-night"><td colSpan={2}>Booking change, paid {fmtDate(c.paidAt)}</td></tr>
                  {c.lines.map(line)}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              {row('Total', tx.breakdown.totalCents, 'paper-total')}
              {row(`Paid by ${tx.method}`, tx.paidCents)}
              {tx.owingCents > 0 && row('Balance due', tx.owingCents, 'paper-total')}
            </tfoot>
          </table>
          {stamp && <div className={`paper-stamp ${stamp.cls}`} aria-label={`Stamped ${stamp.text}`}>{stamp.text}</div>}
          <p className="paper-thanks">Thank you for staying with us!</p>
        </div>
        {(tx.feeCents > 0 || tx.hostNetCents > 0) && (
          <p className="small tx-share">Not on the invoice: SimonStays fee <b>{fmtR(tx.feeCents)}</b> · to host <b>{fmtR(tx.hostNetCents)}</b></p>
        )}
      </div>
    </div>
  );
}

function Transactions({ hostFilter, HostPicker }) {
  const [data, setData] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState(null);

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
        {data && data.rows.length > 0 && <button className="secondary small" onClick={downloadCsv}>⬇ CSV</button>}
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
                  <Fragment key={x.id}>
                  <tr className={x.status === 'cancelled' ? 'muted' : ''}>
                    <td className="small">{fmtDate(x.createdAt)}<div className="muted">{x.ref}</div></td>
                    <td className="small tx-wrap">{x.guestName || '—'}<div className="muted">{x.guestEmail}</div></td>
                    <td className="small">{place(x)}<div className="muted">{fmtDay(x.checkIn)} → {fmtDay(x.checkOut)}</div></td>
                    <td className="small">{x.host}</td>
                    <td className="small">{STATUS[x.status] || x.status}</td>
                    <td className="small">{x.method}{x.paygateRef && <div className="muted">#{x.paygateRef}</div>}</td>
                    <td className="num">
                      <button type="button" className={`tx-icon${openId === x.id ? ' on' : ''}`} title={breakdownSummary(x)} aria-label={`Breakdown of the ${fmtR(x.paidCents)} paid`} aria-expanded={openId === x.id} onClick={() => setOpenId(openId === x.id ? null : x.id)}>🧾</button>
                      {fmtR(x.paidCents)}
                    </td>
                    <td className="num">{fmtR(x.grossCents)}</td>
                    <td className="num"><b>{x.feeCents ? fmtR(x.feeCents) : '—'}</b></td>
                    <td className="num">{x.hostNetCents ? fmtR(x.hostNetCents) : '—'}</td>
                  </tr>
                  {openId === x.id && <tr><td colSpan={10} className="tx-detail"><PaymentBreakdown tx={x} /></td></tr>}
                  </Fragment>
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
