import { useEffect, useRef, useState } from 'react';
import { api, openMessageAttachment } from '../api.js';
import RatingsView, { GuestRatingChip } from './RatingsView.jsx';
import { useAuth } from '../auth.jsx';
import { fmtR, randToCents } from '../money.js';
import TeachSimon from './TeachSimon.jsx';

// Guest messaging. Four tabs:
//   Inbox      — one conversation per booking; send now, optionally from a saved message
//   Saved      — pre-typed messages (with [Shortcuts]) to reuse
//   Scheduled  — automatic messages sent at a time relative to each stay, per property
//   Teach Simon — answer what the Ask Simon AI couldn't, and manage what it knows
// Guests read and reply on the shopfront (simonstays.co.za → Messages) and get an email copy.
export default function MessagesView({ onClose, properties = [], initialBookingId = null, initialTab = 'inbox', onUnreadChange, teachCount = 0 }) {
  const [tab, setTab] = useState(initialTab);
  const [templates, setTemplates] = useState([]);
  const [shortcuts, setShortcuts] = useState([]);

  const loadTemplates = () => api.listMessageTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
  useEffect(() => {
    loadTemplates();
    api.messageMeta().then((r) => setShortcuts(r.shortcuts || [])).catch(() => {});
  }, []);

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Messaging &amp; Ask Simon</span>
        <div className="spacer" />
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="msg-tabs">
        <button className={tab === 'inbox' ? 'on' : ''} onClick={() => setTab('inbox')}>💬 Inbox</button>
        <button className={tab === 'saved' ? 'on' : ''} onClick={() => setTab('saved')}>📝 Saved messages</button>
        <button className={tab === 'scheduled' ? 'on' : ''} onClick={() => setTab('scheduled')}>⏰ Scheduled</button>
        <button className={tab === 'teach' ? 'on' : ''} onClick={() => setTab('teach')}>🧠 Ask Simon{teachCount > 0 && <span className="msg-dot">{teachCount}</span>}</button>
        <button className={tab === 'ratings' ? 'on' : ''} onClick={() => setTab('ratings')}>⭐ Ratings</button>
      </div>

      {tab === 'inbox' && <Inbox templates={templates} shortcuts={shortcuts} properties={properties} initialBookingId={initialBookingId} onUnreadChange={onUnreadChange} onManageSaved={() => setTab('saved')} />}
      {tab === 'saved' && <SavedMessages templates={templates} shortcuts={shortcuts} onChanged={loadTemplates} />}
      {tab === 'scheduled' && <Scheduled templates={templates} shortcuts={shortcuts} properties={properties} />}
      {tab === 'teach' && <TeachSimon properties={properties} onCountChange={onUnreadChange} />}
      {tab === 'ratings' && <RatingsView />}
    </div>
  );
}

function fmtWhen(d) {
  return new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtDay(s) {
  return new Date(s + 'T12:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}
const placeOf = (b) => [b.propertyName, b.unitName && `Unit ${b.unitName}`].filter(Boolean).join(' · ');

const OFFER_STATE = {
  open: 'Awaiting payment', paid: 'Paid', replaced: 'Replaced by a newer invoice',
  expired: 'Expired', closed: 'Closed',
};

// An invoice inside a message (the guest sees the same lines on the shopfront).
function InvoiceCard({ offer, onMarkPaid }) {
  const isChange = offer.kind === 'change';
  const applied = isChange && offer.totalCents <= 0;
  return (
    <div className="msg-invoice">
      <div className="msg-invoice-title"><b>{isChange ? 'Booking change' : 'Invoice'}</b><span className={`msg-invoice-state ${offer.state}`}>{applied ? 'Applied' : OFFER_STATE[offer.state] || offer.state}</span></div>
      {offer.lines.map((l, i) => (
        <div key={i} className="msg-invoice-row"><span>{l.description}</span><span>{fmtR(l.amountCents)}</span></div>
      ))}
      <div className="msg-invoice-row total"><span>Total</span><span>{fmtR(offer.totalCents)}</span></div>
      {offer.state === 'open' && <a className="small" href={offer.link} target="_blank" rel="noreferrer">Open the guest’s payment page ↗</a>}
      {isChange && offer.state === 'open' && onMarkPaid && <div><button type="button" className="secondary small" onClick={() => onMarkPaid(offer)}>Mark as paid (EFT received)</button></div>}
    </div>
  );
}

const nightsOf = (l) => (l.checkIn && l.checkOut ? Math.round((Date.parse(`${l.checkOut}T12:00:00Z`) - Date.parse(`${l.checkIn}T12:00:00Z`)) / 864e5) : 0);
const isDayUse = (l) => !!l.checkIn && l.checkIn === l.checkOut; // same date in and out: charged at the rate once
const stayCents = (l) => (isDayUse(l) ? 1 : Math.max(0, nightsOf(l))) * randToCents(l.rate);
const datesOk = (l) => l.checkIn && l.checkOut && l.checkOut >= l.checkIn;
const nextDay = (ymd) => new Date(Date.parse(`${ymd}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);

// One accommodation line: the unit and dates to block, and this guest's own rate.
// Fills in the pricing sheet's rate until the host types their own.
function StayLine({ line, properties, onChange, onRemove }) {
  const { unitId, checkIn, checkOut } = line;
  const nights = nightsOf(line);
  const dayUse = isDayUse(line);
  const ready = unitId && datesOk(line);
  useEffect(() => {
    if (!ready) { onChange({ standardCents: null, unavailable: false }); return undefined; }
    let live = true;
    // The pricing sheet has no day rate, so the host types one.
    if (dayUse) onChange((l) => ({ standardCents: null, ...(l.rateEdited ? {} : { rate: '' }) }));
    const t = setTimeout(() => {
      if (!dayUse) api.quoteUnit(unitId, { checkIn, checkOut, cleans: 1 })
        .then((r) => {
          if (!live) return;
          const standardCents = Math.round(r.quote.accommodationCents / r.quote.nights);
          onChange((l) => ({ standardCents, ...(l.rateEdited ? {} : { rate: (standardCents / 100).toFixed(2) }) }));
        })
        .catch(() => { if (live) onChange({ standardCents: null }); });
      api.availability(unitId, checkIn, dayUse ? nextDay(checkIn) : checkOut)
        .then((r) => { if (live) onChange({ unavailable: !r.available }); })
        .catch(() => {});
    }, 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line
  }, [unitId, checkIn, checkOut]);

  return (
    <div className="msg-stay">
      <label className="msg-stay-unit"><span>Unit</span>
        <select value={unitId} onChange={(e) => onChange({ unitId: e.target.value })}>
          <option value="">Choose a unit…</option>
          {properties.map((p) => (
            <optgroup key={p.id} label={p.name}>
              {(p.units || []).map((u) => <option key={u.id} value={u.id}>{p.name} · Unit {u.name}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      <label><span>Check-in</span><input type="date" value={checkIn} onChange={(e) => onChange({ checkIn: e.target.value })} /></label>
      <label><span>Check-out</span><input type="date" min={checkIn || undefined} value={checkOut} onChange={(e) => onChange({ checkOut: e.target.value })} /></label>
      <div className="msg-stay-calc"><span>Nights</span><b>{dayUse ? 'Day' : nights > 0 ? nights : '–'}</b></div>
      <label><span>{dayUse ? 'Rate for the day' : 'Rate per night'}</span><input className="amt" inputMode="decimal" placeholder="0.00" value={line.rate} onChange={(e) => onChange({ rate: e.target.value, rateEdited: true })} /></label>
      <div className="msg-stay-calc amt"><span>Amount</span><b>{fmtR(stayCents(line))}</b></div>
      <button type="button" className="mini" aria-label="Remove this accommodation line" onClick={onRemove}>✕</button>
      {(line.standardCents != null || line.unavailable || dayUse || (checkIn && checkOut && nights < 0)) && (
        <div className="msg-stay-note small">
          {checkIn && checkOut && nights < 0 ? <span className="msg-stay-bad">Check-out can't be before check-in.</span>
            : line.unavailable ? <span className="msg-stay-bad">This unit is already booked for these dates.</span>
              : dayUse ? <span className="muted">Day use: this date is blocked on the calendar, including that night.</span>
              : <span className="muted">Standard rate {fmtR(line.standardCents)} a night</span>}
        </div>
      )}
    </div>
  );
}

// Build an invoice from the pricing sheet: accommodation lines say which units
// and dates to block; other lines are fees or discounts. The total is what the guest pays.
function InvoiceComposer({ bookingId, properties, invoice, standardCents, onSent, onCancel }) {
  const nextKey = useRef(0);
  const blankStay = () => ({ key: nextKey.current++, kind: 'stay', unitId: '', checkIn: '', checkOut: '', rate: '', rateEdited: false, standardCents: null, unavailable: false });
  const [lines, setLines] = useState(() => invoice.draftLines.map((l) => (l.kind === 'stay'
    ? { ...blankStay(), unitId: l.unitId, checkIn: l.checkIn, checkOut: l.checkOut, rate: (l.nightlyCents / 100).toFixed(2), rateEdited: l.description != null }
    : { key: nextKey.current++, kind: 'charge', description: l.description, amount: (l.amountCents / 100).toFixed(2), deposit: !!l.deposit })));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const totalCents = lines.reduce((n, l) => n + (l.kind === 'stay' ? stayCents(l) : randToCents(l.amount)), 0);
  const stays = lines.filter((l) => l.kind === 'stay');
  const staysReady = stays.length > 0 && stays.every((l) => l.unitId && datesOk(l) && !l.unavailable);
  const edit = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...(typeof patch === 'function' ? patch(l) : patch) } : l)));
  const remove = (key) => setLines((ls) => ls.filter((l) => l.key !== key));

  async function send() {
    setBusy(true); setErr('');
    try {
      const r = await api.sendInvoice(bookingId, lines.map((l) => (l.kind === 'stay'
        ? { kind: 'stay', unitId: l.unitId, checkIn: l.checkIn, checkOut: l.checkOut, nightlyCents: randToCents(l.rate) }
        : { kind: 'charge', description: l.description, amountCents: randToCents(l.amount), deposit: l.deposit })), note);
      onSent(r.emailed);
    } catch (e) { setErr((e.data && e.data.message) || e.message); setBusy(false); }
  }

  return (
    <div className="msg-composer">
      <div className="msg-composer-head"><b>Invoice for this guest</b>{standardCents != null && <span className="muted small">Standard price {fmtR(standardCents)}</span>}</div>
      {stays.map((l) => (
        <StayLine key={l.key} line={l} properties={properties} onChange={(patch) => edit(l.key, patch)} onRemove={() => remove(l.key)} />
      ))}
      <button type="button" className="secondary small" onClick={() => setLines((ls) => [...ls.filter((l) => l.kind === 'stay'), blankStay(), ...ls.filter((l) => l.kind !== 'stay')])}>＋ Add accommodation</button>
      {lines.filter((l) => l.kind !== 'stay').map((l) => (
        <div key={l.key} className="msg-composer-line">
          <input value={l.description} aria-label="Description" placeholder="Description" onChange={(e) => edit(l.key, { description: e.target.value })} />
          <input className="amt" value={l.amount} aria-label="Amount in rand" inputMode="decimal" placeholder="0.00" onChange={(e) => edit(l.key, { amount: e.target.value })} />
          <button type="button" className="mini" aria-label={`Remove ${l.description || 'line'}`} onClick={() => remove(l.key)}>✕</button>
        </div>
      ))}
      <button type="button" className="secondary small" onClick={() => setLines((ls) => [...ls, { key: nextKey.current++, kind: 'charge', description: '', amount: '', deposit: false }])}>＋ Add an item, fee or discount</button>
      <div className="muted small">For anything not tied to a unit, such as mattress hire. Use a minus amount for a discount, for example -500.</div>
      <div className="msg-invoice-row total"><span>Guest pays</span><span>{fmtR(totalCents)}</span></div>
      <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to the guest (optional)" />
      {err && <div className="msg-warn">{err}</div>}
      <div className="msg-send-row">
        <span className="muted small">The guest has {invoice.validHours} hours to pay. Nothing is blocked until they do.</span>
        <button className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button onClick={send} disabled={busy || totalCents <= 0 || !staysReady}>{busy ? 'Sending…' : `Send ${fmtR(totalCents)} invoice`}</button>
      </div>
    </div>
  );
}

// Invoice a change to a confirmed booking. Nothing changes until it's paid; with
// nothing to pay it applies straight away, and a minus total becomes a refund due.
function ChangeComposer({ bookingId, booking, change, onSent, onCancel }) {
  const nextKey = useRef(0);
  const cents = (c) => (c ? (c / 100).toFixed(2) : '');
  const [lines, setLines] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const add = (line) => setLines((ls) => [...ls, { key: nextKey.current++, amount: '', ...line }]);
  const edit = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key) => setLines((ls) => ls.filter((l) => l.key !== key));
  const hasDates = lines.some((l) => l.kind === 'change');
  const totalCents = lines.reduce((n, l) => n + randToCents(l.amount), 0);
  const ready = lines.length > 0 && lines.every((l) => (l.kind === 'change' ? l.checkIn && l.checkOut && l.checkOut > l.checkIn : !!(l.description || '').trim()));

  async function send() {
    if (totalCents <= 0 && !window.confirm(totalCents < 0 ? `Apply this change now? ${fmtR(-totalCents)} will show as a refund due to the guest.` : 'Apply this change now, at no charge?')) return;
    setBusy(true); setErr('');
    try {
      const r = await api.sendChange(bookingId, lines.map((l) => (l.kind === 'change'
        ? { kind: 'change', checkIn: l.checkIn, checkOut: l.checkOut, amountCents: randToCents(l.amount) }
        : { kind: 'charge', description: l.description, amountCents: randToCents(l.amount), applies: l.applies || null, cleanDate: l.cleanDate || null })), note);
      onSent(r);
    } catch (e) { setErr((e.data && e.data.message) || e.message); setBusy(false); }
  }

  return (
    <div className="msg-composer">
      <div className="msg-composer-head"><b>Amend booking</b><span className="muted small">{fmtDay(booking.checkIn)} → {fmtDay(booking.checkOut)}</span></div>
      <div className="msg-invoice-actions">
        <button type="button" className="secondary small" disabled={hasDates} onClick={() => add({ kind: 'change', checkIn: booking.checkIn, checkOut: booking.checkOut })}>＋ Change dates</button>
        <button type="button" className="secondary small" onClick={() => add({ kind: 'charge', description: 'Late checkout', applies: 'lateCheckOut', amount: cents(change.lateCents) })}>＋ Late checkout</button>
        <button type="button" className="secondary small" onClick={() => add({ kind: 'charge', description: 'Early check-in', applies: 'earlyCheckIn', amount: cents(change.earlyCents) })}>＋ Early check-in</button>
        <button type="button" className="secondary small" onClick={() => add({ kind: 'charge', description: 'Extra clean', applies: 'clean', cleanDate: '', amount: cents(change.cleanCents) })}>＋ Extra clean</button>
        <button type="button" className="secondary small" onClick={() => add({ kind: 'charge', description: '' })}>＋ Other item</button>
      </div>
      {lines.map((l) => (
        <div key={l.key} className="msg-composer-line">
          {l.kind === 'change' ? (
            <>
              <input type="date" aria-label="New check-in" value={l.checkIn} onChange={(e) => edit(l.key, { checkIn: e.target.value })} />
              <input type="date" aria-label="New check-out" min={l.checkIn || undefined} value={l.checkOut} onChange={(e) => edit(l.key, { checkOut: e.target.value })} />
            </>
          ) : (
            <>
              <input value={l.description} aria-label="Description" placeholder="Description" onChange={(e) => edit(l.key, { description: e.target.value })} />
              {l.applies === 'clean' && <input type="date" aria-label="Date of the clean" value={l.cleanDate} onChange={(e) => edit(l.key, { cleanDate: e.target.value })} />}
            </>
          )}
          <input className="amt" value={l.amount} aria-label="Amount in rand" inputMode="decimal" placeholder="0.00" onChange={(e) => edit(l.key, { amount: e.target.value })} />
          <button type="button" className="mini" aria-label={`Remove ${l.description || 'new dates'}`} onClick={() => remove(l.key)}>✕</button>
        </div>
      ))}
      <div className="muted small">Type what the change costs. For a shorter stay, use a minus amount to refund the guest, for example -600.</div>
      <div className="msg-invoice-row total"><span>{totalCents < 0 ? 'Refund due' : 'Guest pays'}</span><span>{fmtR(Math.abs(totalCents))}</span></div>
      <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to the guest (optional)" />
      {err && <div className="msg-warn">{err}</div>}
      <div className="msg-send-row">
        <span className="muted small">{totalCents > 0 ? `The guest has ${change.validHours} hours to pay. The booking and calendar update once they do.` : 'This updates the booking and calendar straight away.'}</span>
        <button className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button onClick={send} disabled={busy || !ready}>{busy ? 'Sending…' : totalCents > 0 ? `Send ${fmtR(totalCents)} invoice` : 'Apply change now'}</button>
      </div>
    </div>
  );
}

// Cancel from the host's side: shows what the policy allows, and the host can change it.
function CancelPanel({ bookingId, cancel, onDone, onClose }) {
  const [refund, setRefund] = useState(cancel.refundCents != null ? (cancel.refundCents / 100).toFixed(2) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try { await api.cancelBooking(bookingId, randToCents(refund)); onDone(); }
    catch (e) { setErr((e.data && e.data.message) || e.message); setBusy(false); }
  }
  return (
    <div className="msg-composer">
      <div className="msg-composer-head"><b>Cancel this booking</b><span className="muted small">{cancel.places.join(', ')}</span></div>
      <div className="small">{cancel.reason}</div>
      <div className="muted small">Paid so far {fmtR(cancel.paidCents)}{cancel.depositCents ? `, including a ${fmtR(cancel.depositCents)} deposit that goes back in full` : ''}.</div>
      <div className="msg-composer-line"><span className="small">Refund to the guest</span><input className="amt" aria-label="Refund in rand" inputMode="decimal" placeholder="0.00" value={refund} onChange={(e) => setRefund(e.target.value)} /></div>
      {err && <div className="msg-warn">{err}</div>}
      <div className="msg-send-row">
        <span className="muted small">The dates are freed straight away and the guest is told.</span>
        <button className="secondary" onClick={onClose} disabled={busy}>Keep booking</button>
        <button onClick={go} disabled={busy}>{busy ? 'Cancelling…' : 'Cancel booking'}</button>
      </div>
    </div>
  );
}

// A refund still to pay: Paygate does these in its own portal, then the host records it here.
function RefundBanner({ bookingId, booking, onDone }) {
  const [amount, setAmount] = useState(booking.refundDueCents != null ? (booking.refundDueCents / 100).toFixed(2) : '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function done() {
    setBusy(true); setErr('');
    try { await api.markRefunded(bookingId, randToCents(amount)); onDone(); }
    catch (e) { setErr((e.data && e.data.message) || e.message); setBusy(false); }
  }
  return (
    <div className="msg-warn">
      <b>{booking.refundDueCents != null ? `Refund due: ${fmtR(booking.refundDueCents)}` : 'Decide the refund for this cancelled booking.'}</b> Pay it in the Paygate portal or by EFT, then record it here.
      <div className="msg-composer-line"><input className="amt" aria-label="Refund paid in rand" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /><button type="button" className="secondary small" disabled={busy} onClick={done}>Mark refund paid</button></div>
      {err && <div>{err}</div>}
    </div>
  );
}

// Friends on this trip, and a link to add one. They see the trip and these messages,
// but not prices or invoices, and they can't change or cancel it.
function TripPeople({ bookingId, travellers, onChanged }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  async function invite() {
    setBusy(true); setNote('');
    try { const r = await api.createTripInvite(bookingId); setLink(r.link); }
    catch (e) { setNote((e.data && e.data.message) || e.message); }
    setBusy(false);
  }
  function copy() {
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
      .then(() => setNote('Link copied.'))
      .catch(() => setNote('Select the link above and copy it.'));
  }
  async function remove(p) {
    if (!window.confirm(`Take ${p.name || p.email} off this trip? They won’t see it or its messages any more.`)) return;
    try { await api.removeTraveller(bookingId, p.id); onChanged(); }
    catch (e) { setNote((e.data && e.data.message) || e.message); }
  }
  return (
    <div className="trip-people">
      {travellers.length > 0 && (
        <span className="small">👥 Also on this trip:{' '}
          {travellers.map((p) => <span key={p.id} className="trip-person">{p.name || p.email} <button type="button" className="msg-link small" onClick={() => remove(p)}>Remove</button></span>)}
        </span>
      )}
      <button type="button" className="secondary small" disabled={busy} onClick={invite}>👥 Invite a friend</button>
      {link && (
        <div className="trip-invite">
          <input readOnly aria-label="Invite link" value={link} onFocus={(e) => e.target.select()} />
          <button type="button" className="secondary small" onClick={copy}>Copy link</button>
          <div className="muted small">Send it to the friend. It works once and lasts 14 days. They see the trip, its door code and these messages, but no prices, and they can’t change or cancel it.</div>
        </div>
      )}
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

// WhatsApp-style status on a message the host sent. "Delivered" is as far as we
// can see: the mail server accepted the guest's email copy.
const TICKS = {
  sent: { marks: '✓', label: 'Sent. The guest sees it when they sign in.' },
  delivered: { marks: '✓✓', label: 'Delivered: emailed to the guest.' },
  read: { marks: '✓✓', label: 'Read by the guest.' },
};
function Ticks({ message: m }) {
  const state = m.readAt ? 'read' : m.emailedAt ? 'delivered' : 'sent';
  return <span className={`msg-ticks ${state}`} title={TICKS[state].label} role="img" aria-label={TICKS[state].label}>{TICKS[state].marks}</span>;
}

// ---------------- Inbox ----------------

function Inbox({ templates, shortcuts, properties, initialBookingId, onUnreadChange, onManageSaved }) {
  const [threads, setThreads] = useState(null);
  const [activeId, setActiveId] = useState(initialBookingId);
  const [thread, setThread] = useState(null); // { booking, messages }
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [picking, setPicking] = useState(false);
  const [tool, setTool] = useState(null); // the open composer helper: 'saved', 'shortcuts' or null
  const [schedules, setSchedules] = useState([]);
  const [pickedSchedule, setPickedSchedule] = useState(null); // the scheduled message this draft came from
  const draftEl = useRef(null);
  const [invoicing, setInvoicing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [q, setQ] = useState('');
  const [recipients, setRecipients] = useState([]);
  const endRef = useRef(null);

  const loadThreads = () => api.messageThreads().then((r) => setThreads(r.threads)).catch(() => setThreads((t) => t || []));
  const loadThread = (id) => api.bookingMessages(id).then((r) => { setThread(r); onUnreadChange && onUnreadChange(); }).catch(() => {});

  useEffect(() => {
    loadThreads();
    const t = setInterval(() => { loadThreads(); if (activeId) loadThread(activeId); }, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [activeId]);
  useEffect(() => { setThread(null); setDraft(''); setNote(''); setInvoicing(false); setTool(null); setPickedSchedule(null); if (activeId) loadThread(activeId); /* eslint-disable-next-line */ }, [activeId]);
  useEffect(() => { endRef.current && endRef.current.scrollIntoView({ block: 'end' }); }, [thread]);
  useEffect(() => {
    if (!picking) return;
    const t = setTimeout(() => api.messageRecipients(q).then((r) => setRecipients(r.bookings)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [picking, q]);

  useEffect(() => {
    if (tool === 'saved') api.listMessageSchedules().then((r) => setSchedules(r.schedules)).catch(() => {});
  }, [tool]);
  // Fill the draft from a scheduled message. Sending it counts as that message
  // having gone, so a guest who booked before it was set up gets it just once.
  async function insertScheduled(s) {
    const text = s.templateId ? (templates.find((t) => t.id === s.templateId) || {}).body : s.body;
    if (!text || !activeId) return;
    setTool(null);
    setPickedSchedule(s.id);
    try { const r = await api.renderMessage(activeId, text); setDraft(r.body); }
    catch { setDraft(text); }
  }
  async function insertTemplate(id) {
    const t = templates.find((x) => x.id === id);
    if (!t || !activeId) return;
    setTool(null);
    try { const r = await api.renderMessage(activeId, t.body); setDraft((d) => (d.trim() ? `${d}\n\n${r.body}` : r.body)); }
    catch { setDraft((d) => (d.trim() ? `${d}\n\n${t.body}` : t.body)); }
  }
  async function send() {
    if (!draft.trim() || !activeId) return;
    setBusy(true); setNote('');
    try {
      const r = await api.sendMessage(activeId, draft, pickedSchedule);
      setDraft('');
      setPickedSchedule(null);
      setNote(r.emailed ? 'Sent — and emailed to the guest.' : 'Sent. (No email copy — the guest will see it when they sign in.)');
      await Promise.all([loadThread(activeId), loadThreads()]);
    } catch (e) { setNote((e.data && e.data.message) || e.message); }
    finally { setBusy(false); }
  }

  async function unsend(m) {
    const already = [m.readAt && 'The guest has already read it.', m.emailedAt && 'They were also emailed a copy, and that can’t be taken back.'].filter(Boolean).join(' ');
    if (!window.confirm(`Unsend this message? It’s deleted for you and the guest, and can’t be brought back.${already ? ` ${already}` : ''}`)) return;
    try { await api.unsendMessage(activeId, m.id); await refreshThread('Message unsent.'); }
    catch (e) { setNote((e.data && e.data.message) || e.message); }
  }
  async function invoiceSent(emailed) {
    setInvoicing(false);
    setNote(emailed ? 'Invoice sent, and emailed to the guest.' : 'Invoice sent. (No email copy: the guest will see it when they sign in.)');
    await Promise.all([loadThread(activeId), loadThreads()]);
  }
  async function refreshThread(message) {
    setChanging(false); setCancelling(false);
    if (message) setNote(message);
    await Promise.all([loadThread(activeId), loadThreads()]);
  }
  async function markChangePaid(offer) {
    if (!window.confirm(`Mark ${fmtR(offer.totalCents)} as received? This updates the booking and calendar.`)) return;
    try { await api.markChangePaid(activeId, offer.id); await refreshThread('Marked as paid. The booking is updated.'); }
    catch (e) { setNote((e.data && e.data.message) || e.message); }
  }
  async function closeEnquiry() {
    if (!window.confirm('Close this enquiry? The guest won’t be able to pay any invoice on it.')) return;
    try { await api.closeEnquiry(activeId); await Promise.all([loadThread(activeId), loadThreads()]); }
    catch (e) { setNote((e.data && e.data.message) || e.message); }
  }

  const b = thread && thread.booking;
  return (
    <div className={`msg-layout${activeId ? ' has-active' : ''}`}>
      <aside className="msg-list">
        <button className="wide" onClick={() => { setPicking(!picking); setQ(''); }}>{picking ? '← Back to conversations' : '＋ New message'}</button>
        {picking ? (
          <>
            <input type="search" className="msg-search" autoFocus placeholder="Guest name, email or ref…" value={q} onChange={(e) => setQ(e.target.value)} />
            {recipients.length === 0 && <p className="muted small">No current or upcoming bookings match.</p>}
            {recipients.map((r) => (
              <button key={r.id} className="msg-item" onClick={() => { setActiveId(r.id); setPicking(false); }}>
                <b>{r.guestName || 'Guest'}</b>
                <span className="muted small">{placeOf(r)} · {fmtDay(r.checkIn)} → {fmtDay(r.checkOut)}</span>
                {!r.reachable && <span className="msg-warn small">No guest email — add one on the booking</span>}
              </button>
            ))}
          </>
        ) : !threads ? <p className="muted small">Loading…</p> : threads.length === 0 ? (
          <p className="muted small">No conversations yet. Start one with ＋ New message, or set up ⏰ Scheduled messages.</p>
        ) : threads.map((t) => (
          <button key={t.booking.id} className={`msg-item${t.booking.id === activeId ? ' on' : ''}`} onClick={() => setActiveId(t.booking.id)}>
            <span className="msg-item-top"><b>{t.booking.guestName || 'Guest'}</b>{t.booking.status === 'enquiry' && <span className="msg-enquiry-tag">Enquiry</span>}{t.booking.status === 'cancelled' && <span className="msg-enquiry-tag">Cancelled</span>}{t.unread > 0 && <span className="msg-dot">{t.unread}</span>}</span>
            <span className="muted small">{placeOf(t.booking)} · {fmtDay(t.booking.checkIn)} → {fmtDay(t.booking.checkOut)}</span>
            <span className="msg-snippet small">{t.last.sender === 'host' ? 'You: ' : ''}{t.last.body}</span>
          </button>
        ))}
      </aside>

      <section className="msg-thread">
        {!activeId ? <p className="muted center">Pick a conversation, or start a new one.</p> : !thread ? <p className="muted small">Loading…</p> : (
          <>
            <div className="msg-thread-head">
              <button className="secondary msg-back" onClick={() => setActiveId(null)}>←</button>
              <div className="msg-summary">
                <div>
                  <b>{b.guestName || 'Guest'}</b>{b.status === 'enquiry' && <span className="msg-enquiry-tag">Enquiry</span>}{b.status === 'cancelled' && <span className="msg-enquiry-tag">Cancelled</span>}{b.ref ? <span className="muted small"> · {b.ref}</span> : null}
                  <GuestRatingChip rating={thread.guestRating} />
                  <div className="muted small">{placeOf(b)}{b.guestEmail ? ` · ${b.guestEmail}` : ''}</div>
                  <div className="small">{b.dayUse ? `${fmtDay(b.checkIn)} · day use` : <>{fmtDay(b.checkIn)} → {fmtDay(b.checkOut)} · {b.nights} night{b.nights === 1 ? '' : 's'}</>}</div>
                </div>
                <div className="msg-summary-price">
                  <b>{b.amountCents != null ? fmtR(b.amountCents) : thread.standardCents != null ? fmtR(thread.standardCents) : 'No price yet'}</b>
                  {thread.standardCents != null && b.amountCents != null && b.amountCents !== thread.standardCents && <div className="muted small">Standard {fmtR(thread.standardCents)}</div>}
                  {b.status === 'cancelled' ? <div className="muted small">{b.refundedAt ? `Refunded ${fmtR(b.refundDueCents || 0)}` : 'Cancelled'}</div> : b.paid ? <div className="small msg-paid">Paid</div> : b.paidCents > 0 ? <div className="muted small">{fmtR(b.paidCents)} paid</div> : null}
                </div>
              </div>
            </div>
            <TripPeople key={b.id} bookingId={activeId} travellers={thread.travellers || []} onChanged={() => loadThread(activeId)} />
            {!b.reachable && (
              <div className="msg-warn">This booking has no guest email or SimonStays account, so nobody will see these messages. Add the guest’s email on the booking first.</div>
            )}
            {b.status === 'cancelled' && !b.refundedAt && (b.refundDueCents > 0 || (b.refundDueCents == null && thread.cancel.paidCents > 0)) && <RefundBanner key={b.id} bookingId={activeId} booking={b} onDone={() => refreshThread('Refund recorded, and the guest has been told.')} />}
            {b.status !== 'cancelled' && !b.refundedAt && b.refundDueCents > 0 && <RefundBanner key={b.id} bookingId={activeId} booking={b} onDone={() => refreshThread('Refund recorded, and the guest has been told.')} />}
            <div className="msg-bubbles">
              {thread.messages.length === 0 && <p className="muted small center">No messages yet.</p>}
              {thread.messages.map((m) => (
                <div key={m.id} className={`msg-bubble ${m.sender}`}>
                  {m.scheduleName && <div className="msg-auto">⏰ {m.scheduleName}</div>}
                  {m.sender === 'guest' && m.authorName && (thread.travellers || []).length > 0 && <div className="msg-auto">{m.authorName}</div>}
                  <div className="msg-body">{m.body}</div>
                  {(m.attachments || []).map((a) => (
                    <div key={a.id}><button type="button" className="linklike" onClick={() => openMessageAttachment(a.id).catch(() => window.alert('Could not open that file.'))}>📎 Open {a.filename}</button></div>
                  ))}
                  {m.offer && <InvoiceCard offer={m.offer} onMarkPaid={markChangePaid} />}
                  <div className="msg-meta">
                    {m.sender === 'host' && !m.offer && <button type="button" className="msg-link msg-unsend" onClick={() => unsend(m)}>Unsend</button>}
                    {fmtWhen(m.createdAt)}
                    {m.sender === 'host' && <Ticks message={m} />}
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
            {changing && !thread.change.blocked ? (
              <ChangeComposer bookingId={activeId} booking={b} change={thread.change} onSent={(r) => refreshThread(r.applied ? 'The booking is updated, and the guest has been told.' : 'Change invoice sent. The booking updates once it is paid.')} onCancel={() => setChanging(false)} />
            ) : cancelling && !thread.cancel.blocked ? (
              <CancelPanel bookingId={activeId} cancel={thread.cancel} onDone={() => refreshThread('Booking cancelled, and the guest has been told.')} onClose={() => setCancelling(false)} />
            ) : invoicing && thread.invoice && !thread.invoice.blocked ? (
              <InvoiceComposer bookingId={activeId} properties={properties} invoice={thread.invoice} standardCents={thread.standardCents} onSent={invoiceSent} onCancel={() => setInvoicing(false)} />
            ) : (
            <div className="msg-compose">
              {thread.invoice && !thread.invoice.blocked && (
                <div className="msg-invoice-actions">
                  <button className="secondary" onClick={() => setInvoicing(true)}>🧾 Send an invoice</button>
                  {b.status === 'enquiry' && <button className="secondary" onClick={closeEnquiry}>Close enquiry</button>}
                </div>
              )}
              {(!thread.change.blocked || !thread.cancel.blocked) && (
                <div className="msg-invoice-actions">
                  {!thread.change.blocked && <button className="secondary" onClick={() => setChanging(true)}>✏️ Amend booking</button>}
                  {!thread.cancel.blocked && <button className="secondary" onClick={() => setCancelling(true)}>Cancel booking</button>}
                </div>
              )}
              <div className="msg-compose-tools">
                <button type="button" className="secondary small" aria-expanded={tool === 'saved'} onClick={() => setTool(tool === 'saved' ? null : 'saved')}>📝 Use a saved or scheduled message</button>
                <button type="button" className="secondary small" aria-expanded={tool === 'shortcuts'} onClick={() => setTool(tool === 'shortcuts' ? null : 'shortcuts')}>[ ] Shortcuts</button>
              </div>
              {tool === 'saved' && (
                <div className="msg-picker">
                  <div className="msg-sched-head">Saved messages</div>
                  {templates.length === 0 && <span className="muted small">No saved messages yet.</span>}
                  {templates.map((t) => (
                    <button key={t.id} type="button" className="msg-item" onClick={() => insertTemplate(t.id)}>
                      <b>{t.name}</b>
                      <span className="msg-snippet small">{t.body}</span>
                    </button>
                  ))}
                  <button type="button" className="msg-link small" onClick={onManageSaved}>{templates.length === 0 ? 'Create a saved message' : 'Manage saved messages'}</button>
                  <div className="msg-sched-head">Scheduled messages</div>
                  {schedules.filter((s) => !s.propertyIds.length || s.propertyIds.includes(b.propertyId)).map((s) => {
                    const sent = thread.messages.some((m) => m.scheduleId === s.id);
                    return (
                      <button key={s.id} type="button" className="msg-item" onClick={() => insertScheduled(s)}>
                        <b>{s.name}</b>
                        <span className="msg-snippet small">{s.templateId ? (templates.find((t) => t.id === s.templateId) || {}).body : s.body}</span>
                        <span className={`msg-item-state${sent ? ' off' : ''}`}>{sent ? 'Already sent to this guest' : 'Not sent to this guest yet'}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {tool === 'shortcuts' && <ShortcutChips shortcuts={shortcuts} onPick={(token) => insertInto(draftEl.current, draft, token, setDraft)} />}
              <textarea ref={draftEl} rows={4} value={draft} onChange={(e) => { setDraft(e.target.value); if (!e.target.value.trim()) setPickedSchedule(null); }} placeholder="Write to the guest…" />
              <ShortcutWarning text={draft} shortcuts={shortcuts} />
              <div className="msg-send-row">
                <span className="muted small">{note}</span>
                <button disabled={busy || !draft.trim()} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
              </div>
            </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ---------------- Shortcuts ----------------

// The compact row of shortcuts above the Inbox's message box.
function ShortcutChips({ shortcuts, onPick }) {
  return (
    <div className="msg-chips">
      <span className="muted small">Filled in when you send:</span>
      {shortcuts.map((s) => <button key={s.key} type="button" className="mini" title={s.hint} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(`[${s.label}]`)}>{`[${s.label}]`}</button>)}
    </div>
  );
}

// Every shortcut, beside whatever message is being written. With no onPick there's
// nothing to insert into, so it's a reference list and `note` says why.
function ShortcutPanel({ shortcuts, onPick, note }) {
  return (
    <aside className="msg-shortcuts">
      <div className="msg-shortcuts-title">Shortcuts</div>
      <div className="muted small">{note || 'Click one to add it to your message, or type it in square brackets. It fills in for each booking when sent.'}</div>
      {shortcuts.map((s) => (
        <button key={s.key} type="button" className="msg-shortcut" disabled={!onPick} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(`[${s.label}]`)}>
          <code>{`[${s.label}]`}</code>
          <span className="muted small">{s.hint}</span>
        </button>
      ))}
    </aside>
  );
}

const shortcutId = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Warns about bracketed text that isn't a shortcut, such as a typo: it would reach
// the guest exactly as typed.
function ShortcutWarning({ text, shortcuts }) {
  if (!shortcuts.length) return null;
  const known = new Set(shortcuts.map((s) => shortcutId(s.key)));
  const unknown = [...new Set(String(text || '').match(/\[[^[\]\n]+\]/g) || [])].filter((t) => !known.has(shortcutId(t)));
  if (!unknown.length) return null;
  return <div className="msg-warn">{unknown.join(', ')} {unknown.length === 1 ? 'isn’t a shortcut' : 'aren’t shortcuts'}, so the guest will see {unknown.length === 1 ? 'it' : 'them'} exactly as typed.</div>;
}

// Insert text at the cursor of a textarea and return the new value.
function insertAt(el, value, text) {
  if (!el) return value + text;
  const s = el.selectionStart ?? value.length, e = el.selectionEnd ?? value.length;
  return value.slice(0, s) + text + value.slice(e);
}

// Insert text at the cursor, then keep the cursor just after it for the next one.
function insertInto(el, value, text, apply) {
  const at = el ? el.selectionStart + text.length : 0;
  apply(insertAt(el, value, text));
  if (el) requestAnimationFrame(() => { el.focus(); el.setSelectionRange(at, at); });
}

// ---------------- Saved messages ----------------

function SavedMessages({ templates, shortcuts, onChanged }) {
  const [rows, setRows] = useState(templates);
  const [nw, setNw] = useState({ name: '', body: '' });
  const [msg, setMsg] = useState('');
  const focused = useRef(null); // { id, el } — the textarea a shortcut inserts into
  const newBody = useRef(null);
  useEffect(() => setRows(templates), [templates]);
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1600); };

  function pick(token) {
    const f = focused.current;
    const row = f && rows.find((r) => r.id === f.id);
    if (row) insertInto(f.el, row.body, token, (body) => edit(row.id, { body }));
    else insertInto(f && f.id === 'new' ? f.el : newBody.current, nw.body, token, (body) => setNw((n) => ({ ...n, body })));
  }
  async function add() {
    if (!nw.name.trim() || !nw.body.trim()) { setMsg('Give it a name and a message.'); return; }
    try { await api.createMessageTemplate(nw); setNw({ name: '', body: '' }); await onChanged(); flash('Saved.'); }
    catch (e) { setMsg(e.message); }
  }
  async function save(r) {
    if (!r.dirty) return;
    try { await api.updateMessageTemplate(r.id, { name: r.name, body: r.body }); await onChanged(); flash('Saved.'); }
    catch (e) { setMsg(e.message); }
  }
  async function remove(r) {
    if (!window.confirm(`Delete the saved message “${r.name}”? Scheduled messages using it keep its current text.`)) return;
    try { await api.deleteMessageTemplate(r.id); await onChanged(); } catch (e) { setMsg(e.message); }
  }
  const edit = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch, dirty: true } : r)));

  return (
    <div className="msg-with-shortcuts">
      <div>
      <p className="muted small">Pre-typed messages you can drop into a conversation. Shortcuts like <code>[First Name]</code> are filled in for each booking when it’s sent. {msg && <b>{msg}</b>}</p>

      <section className="sp-card">
        <input className="sp-name" placeholder="Name, e.g. Check-in instructions" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} />
        <textarea ref={newBody} className="msg-tpl-body" rows={5} placeholder={'Hi [First Name], welcome to [Property]! Check-in is from [Check In Time]…'} value={nw.body}
          onFocus={(e) => { focused.current = { id: 'new', el: e.target }; }} onChange={(e) => setNw({ ...nw, body: e.target.value })} />
        <ShortcutWarning text={nw.body} shortcuts={shortcuts} />
        <button onClick={add}>➕ Save message</button>
      </section>

      {rows.map((r) => (
        <section key={r.id} className="sp-card">
          <div className="sp-top">
            <input className="sp-name" value={r.name} onChange={(e) => edit(r.id, { name: e.target.value })} onBlur={() => save(r)} />
            <button className="del" title="Delete" onClick={() => remove(r)}>🗑</button>
          </div>
          <textarea className="msg-tpl-body" rows={5} value={r.body}
            onFocus={(e) => { focused.current = { id: r.id, el: e.target }; }}
            onChange={(e) => edit(r.id, { body: e.target.value })} onBlur={() => save(r)} />
          <ShortcutWarning text={r.body} shortcuts={shortcuts} />
        </section>
      ))}
      </div>
      <ShortcutPanel shortcuts={shortcuts} onPick={pick} />
    </div>
  );
}

// ---------------- Scheduled messages ----------------

const BLANK = { id: null, name: '', templateId: '', body: '', anchor: 'confirmed', offsetDays: 0, offsetMinutes: 0, sendTime: '10:00', propertyIds: [], noProperties: false, active: true };

// Common messages a host can start from. Picking one only opens a draft: nothing
// sends until the host presses Create.
const SUGGESTED = [
  { name: 'Booking confirmed', anchor: 'confirmed', offsetDays: 0,
    body: 'Hi [First Name], your stay at [Property] is confirmed.\n\nCheck-in: [Check In] from [Check In Time]\nCheck-out: [Check Out] by [Check Out Time]\nReference: [Ref]\n\nWe look forward to hosting you.\n[Host Name]' },
  { name: 'Check-in details', anchor: 'check_in', offsetDays: -1, sendTime: '10:00',
    body: 'Hi [First Name], you check in tomorrow from [Check In Time].\n\n[Property], Unit [Unit]\n[Address]\n\nAccess code: [Access Code]\nParking: [Parking]\nWifi: [Wifi Name], password [Wifi Password]\n\n[Host Name]' },
  { name: 'Welcome on arrival day', anchor: 'check_in', offsetDays: 0, sendTime: '16:00',
    body: 'Welcome to [Property], [First Name]! We hope you settle in well. Message us here if you need anything.\n\n[Host Name]' },
  { name: 'Check-out reminder', anchor: 'check_out', offsetDays: -1, sendTime: '18:00',
    body: 'Hi [First Name], a reminder that check-out is tomorrow by [Check Out Time]. We hope you’ve enjoyed your stay at [Property].\n\n[Host Name]' },
  { name: 'Thank you after the stay', anchor: 'check_out', offsetDays: 1, sendTime: '10:00',
    body: 'Thank you for staying at [Property], [First Name]. We’d love to host you again.\n\n[Host Name]' },
];

// The choices for when to send: minutes after a booking, or days around a stay.
const BOOKED_DELAYS = [0, 5, 15, 30, 60, 120, 240, 480, 1440];
const STAY_DAYS = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7];

function delayLabel(m) {
  if (!m) return 'Immediately after';
  if (m < 60) return `${m} minutes after`;
  const h = m / 60;
  return `${h} hour${h === 1 ? '' : 's'} after`;
}
function dayLabel(d, what) {
  if (!d) return `Day of ${what}`;
  const n = Math.abs(d);
  return `${n} day${n === 1 ? '' : 's'} ${d < 0 ? 'before' : 'after'}`;
}

function describe(s, properties) {
  const what = s.anchor === 'check_out' ? 'check-out' : 'check-in';
  let when;
  if (s.anchor === 'confirmed') when = `${delayLabel(s.offsetMinutes)} booking`;
  else when = (s.offsetDays ? `${dayLabel(s.offsetDays, what)} ${what}` : dayLabel(0, what)) + ` at ${s.sendTime}`;
  if (s.noProperties) return `${when} · no properties, so it won’t send`;
  const props = s.propertyIds.length ? properties.filter((p) => s.propertyIds.includes(p.id)).map((p) => p.name).join(', ') : 'all properties';
  return `${when} · ${props}`;
}

// What the system sends by itself, only when something happens on a booking.
const EVENT_MESSAGES = [
  ['You send an invoice', 'The invoice and a link to pay it by card'],
  ['You change a booking', 'What changed and, if there’s more to pay, a link to pay it'],
  ['A change is paid', 'Confirmation that the booking is updated'],
  ['A booking is cancelled', '“This booking has been cancelled”, with any refund due'],
  ['You record a refund', '“Your refund has been paid”'],
  ['You answer an Ask Simon question', 'Your answer to what they asked'],
  ['They forget their password', 'A link to reset it'],
];

// A message's text with its shortcuts picked out, so they're easy to check.
function WithShortcuts({ text }) {
  return String(text || '').split(/(\[[^[\]\n]+\]|\{\w+\})/).map((part, i) => (i % 2 ? <span key={i} className="jr-token">{part}</span> : part));
}

// The order messages reach a guest, around the moments that matter on a stay.
function journeyStages(rows) {
  const byDays = (a, b) => a.offsetDays - b.offsetDays;
  const inStay = rows.filter((r) => r.anchor !== 'confirmed');
  const ofCheckIn = inStay.filter((r) => r.anchor === 'check_in');
  const ofCheckOut = inStay.filter((r) => r.anchor === 'check_out');
  const byTime = (a, b) => a.sendTime.localeCompare(b.sendTime);
  return [
    { id: 'confirmed', milestone: 'Booking confirmed', icon: '✅', rows: rows.filter((r) => r.anchor === 'confirmed').sort((a, b) => (a.offsetMinutes || 0) - (b.offsetMinutes || 0)) },
    { id: 'before', title: 'Before check-in', rows: ofCheckIn.filter((r) => r.offsetDays < 0).sort(byDays) },
    { id: 'checkin', milestone: 'Check-in day', icon: '🔑', rows: ofCheckIn.filter((r) => r.offsetDays === 0).sort(byTime) },
    { id: 'during', title: 'During the stay', note: 'Counted from check-in, then back from check-out, so the order can shift on a short stay.',
      rows: [...ofCheckIn.filter((r) => r.offsetDays > 0).sort(byDays), ...ofCheckOut.filter((r) => r.offsetDays < 0).sort(byDays)] },
    { id: 'checkout', milestone: 'Check-out day', icon: '🧳', rows: ofCheckOut.filter((r) => r.offsetDays === 0).sort(byTime) },
    { id: 'after', title: 'After check-out', rows: ofCheckOut.filter((r) => r.offsetDays > 0).sort(byDays) },
  ];
}

function journeyWhen(r) {
  if (r.anchor === 'confirmed') return delayLabel(r.offsetMinutes);
  const what = r.anchor === 'check_out' ? 'check-out' : 'check-in';
  return r.offsetDays ? `${dayLabel(r.offsetDays, what)} ${what}, ${r.sendTime}` : r.sendTime;
}

// Every saved scheduled message in the order a guest receives them, for checking
// that the whole conversation flows. Clicking one opens it for editing.
function GuestJourney({ rows, templates, properties, onOpen }) {
  const [propertyId, setPropertyId] = useState('');
  const [full, setFull] = useState(false);
  const textOf = (r) => (r.templateId ? (templates.find((t) => t.id === r.templateId) || {}).body : r.body);
  const reaches = (r) => !r.noProperties && (!r.propertyIds.length || r.propertyIds.includes(propertyId));
  const saved = rows.filter((r) => r.id && (!propertyId || reaches(r)));
  const stages = journeyStages(saved);
  const live = (r) => r.active && !r.noProperties;
  const noConfirmation = !stages[0].rows.some(live);
  const nameOf = (id) => (properties.find((p) => p.id === id) || {}).name;

  return (
    <div className="jr">
      <div className="jr-tools">
        <label className="msg-field">Show the journey for
          <select aria-label="Show the journey for" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            <option value="">All properties</option>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="chk"><input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> Show full messages</label>
      </div>

      <ol className="jr-line">
        <li className="jr-stage milestone">
          <div className="jr-marker">📝</div>
          <h3>Guest books on SimonStays</h3>
          <div className="jr-card system">
            <div className="jr-when">As they book, before paying · sent automatically</div>
            <b>Booking invoice email</b>
            <div className="jr-text">The stay, the price and the cancellation policy, marked “awaiting payment”.</div>
          </div>
        </li>
        {stages.map((s) => {
          if (!s.milestone && !s.rows.length) return null;
          return (
            <li key={s.id} className={`jr-stage${s.milestone ? ' milestone' : ''}`}>
              <div className="jr-marker">{s.icon || ''}</div>
              <h3>{s.milestone || s.title}</h3>
              {s.note && <div className="muted small jr-note">{s.note}</div>}
              {s.id === 'confirmed' && noConfirmation && (
                <div className="msg-warn jr-gap">Nothing tells the guest their payment went through. Their last email still says “awaiting payment”, so add a message here.</div>
              )}
              {s.milestone && !s.rows.length && !(s.id === 'confirmed' && noConfirmation) && <div className="muted small jr-note">Nothing sent.</div>}
              {s.rows.map((r) => (
                <button key={r.id} type="button" className={`jr-card${live(r) ? '' : ' off'}`} onClick={() => onOpen(r.id)}>
                  <div className="jr-when">{journeyWhen(r)}{!r.active ? ' · switched off' : r.noProperties ? ' · no properties, won’t send' : ''}</div>
                  <b>{r.name}</b>
                  <div className={`jr-text${full ? ' full' : ''}`}><WithShortcuts text={textOf(r)} /></div>
                  {!propertyId && r.propertyIds.length > 0 && <div className="jr-props">Only {r.propertyIds.map(nameOf).filter(Boolean).join(', ')}</div>}
                </button>
              ))}
            </li>
          );
        })}
      </ol>

      <section className="jr-events">
        <h3>Only when something happens</h3>
        <p className="muted small">These go out by themselves when needed, whatever you schedule above.</p>
        {EVENT_MESSAGES.map(([when, what]) => <div key={when} className="jr-event"><b>{when}</b><span>{what}</span></div>)}
      </section>
      <p className="muted small">Each message appears in the guest’s SimonStays inbox and is emailed to them. Guests with no email or SimonStays account, such as most Airbnb bookings, get none of these. If someone books late, messages more than a day past their send time are skipped.</p>
    </div>
  );
}

const scheduleRow = (s) => ({ ...s, templateId: s.templateId || '', body: s.body || '' });

// The ideas this host has dismissed, remembered per host in this browser.
const hiddenIdeasKey = (hostId) => `staysync_hidden_ideas_${hostId}`;
function readHiddenIdeas(hostId) {
  try { return JSON.parse(localStorage.getItem(hiddenIdeasKey(hostId))) || []; } catch { return []; }
}

function Scheduled({ templates, shortcuts, properties }) {
  const [rows, setRows] = useState(null);
  const [activeKey, setActiveKey] = useState(null);
  const [view, setView] = useState('messages');
  const [msg, setMsg] = useState('');
  const { host } = useAuth();
  const [hiddenIdeas, setHiddenIdeas] = useState(() => readHiddenIdeas(host.id));
  const bodyEl = useRef(null);
  const nextDraft = useRef(0);
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1800); };
  useEffect(() => {
    api.listMessageSchedules().then((r) => setRows(r.schedules.map(scheduleRow))).catch((e) => setMsg(e.message));
  }, []);

  const keyOf = (r) => r.id || r._key;
  const edit = (key, patch) => setRows((rs) => rs.map((r) => (keyOf(r) === key ? { ...r, ...patch, dirty: true } : r)));

  function startDraft(from) {
    const _key = `new${nextDraft.current++}`;
    setRows((rs) => [{ ...BLANK, ...from, _key, dirty: true }, ...rs]);
    setActiveKey(_key);
  }
  // Only the saved row is replaced, so unsaved edits to the others survive.
  async function save(r) {
    const data = { name: r.name, templateId: r.templateId || null, body: r.templateId ? null : r.body, anchor: r.anchor,
      offsetDays: r.offsetDays, offsetMinutes: r.offsetMinutes, sendTime: r.sendTime, propertyIds: r.propertyIds, noProperties: !!r.noProperties, active: r.active };
    try {
      const { schedule } = r.id ? await api.updateMessageSchedule(r.id, data) : await api.createMessageSchedule(data);
      setRows((rs) => rs.map((x) => (keyOf(x) === keyOf(r) ? scheduleRow(schedule) : x)));
      setActiveKey(schedule.id);
      flash('Saved.');
    } catch (e) { setMsg((e.data && e.data.message) || e.message); }
  }
  function saveHiddenIdeas(names) {
    setHiddenIdeas(names);
    try { localStorage.setItem(hiddenIdeasKey(host.id), JSON.stringify(names)); } catch { /* still hidden for this visit */ }
  }
  async function remove(r, key) {
    if (r.id) {
      if (!window.confirm(`Delete the scheduled message “${r.name}”? It stops sending. Messages already sent stay in the guest’s conversation.`)) return;
      try { await api.deleteMessageSchedule(r.id); } catch (e) { setMsg((e.data && e.data.message) || e.message); return; }
    } else if ((r.name || r.body) && !window.confirm(`Discard the draft “${r.name || 'Untitled message'}”?`)) return;
    setRows((rs) => rs.filter((x) => keyOf(x) !== key));
    setActiveKey((k) => (k === key ? null : k));
    // Otherwise a deleted message comes straight back as an idea.
    const idea = SUGGESTED.find((s) => s.name.toLowerCase() === r.name.trim().toLowerCase());
    if (idea && !hiddenIdeas.includes(idea.name)) saveHiddenIdeas([...hiddenIdeas, idea.name]);
  }

  if (!rows) return <div className="gb-wrap"><p className="muted small">{msg || 'Loading…'}</p></div>;
  const r = rows.find((x) => keyOf(x) === activeKey);
  const key = r && keyOf(r);
  const template = r && r.templateId ? templates.find((t) => t.id === r.templateId) : null;
  const booked = r && r.anchor === 'confirmed';
  const whenValue = r ? (booked ? r.offsetMinutes || 0 : r.offsetDays) : 0;
  // One already saved outside these choices stays on the list until it's changed.
  const whenChoices = r ? [...new Set([...(booked ? BOOKED_DELAYS : STAY_DAYS), whenValue])].sort((x, y) => x - y) : [];
  const setEvent = (anchor) => edit(key, anchor === 'confirmed'
    ? { anchor, offsetDays: 0, offsetMinutes: 0 }
    : { anchor, offsetMinutes: 0, offsetDays: booked ? -1 : r.offsetDays });
  const taken = new Set(rows.map((x) => x.name.trim().toLowerCase()));
  const ideas = SUGGESTED.filter((s) => !taken.has(s.name.toLowerCase()) && !hiddenIdeas.includes(s.name));

  return (
    <>
      <p className="muted small msg-sched-intro">
        Automatic messages go to every confirmed booking that matches — once per booking — and are emailed to the guest too.
        Only bookings with a guest email or SimonStays account receive them. {msg && <b>{msg}</b>}
      </p>
      <div className="msg-tabs sub jr-switch">
        <button className={view === 'messages' ? 'on' : ''} onClick={() => setView('messages')}>✏️ Edit messages</button>
        <button className={view === 'journey' ? 'on' : ''} onClick={() => setView('journey')}>🗺 Guest journey</button>
      </div>
      {view === 'journey' ? <GuestJourney rows={rows} templates={templates} properties={properties} onOpen={(id) => { setActiveKey(id); setView('messages'); }} /> : (
      <div className={`msg-sched-layout${r ? ' has-active' : ''}`}>
        <aside className="msg-list">
          <button className="wide" onClick={() => startDraft({})}>➕ New scheduled message</button>
          {rows.length === 0 && <p className="muted small">None set up yet.</p>}
          {rows.map((x) => (
            <div key={keyOf(x)} className="msg-item-wrap">
              <button className={`msg-item${keyOf(x) === activeKey ? ' on' : ''}`} onClick={() => setActiveKey(keyOf(x))}>
                <b>{x.name || 'Untitled message'}</b>
                <span className="muted small">{describe(x, properties)}</span>
                <span className={`msg-item-state${!x.id || x.dirty ? ' draft' : x.active ? '' : ' off'}`}>{!x.id ? 'Draft, not created yet' : x.dirty ? 'Unsaved changes' : x.active ? `Active · sent ${x.sentCount}×` : `Off · sent ${x.sentCount}×`}</span>
              </button>
              <button type="button" className="msg-item-del" title={x.id ? 'Delete' : 'Discard'} aria-label={`${x.id ? 'Delete' : 'Discard'} ${x.name || 'Untitled message'}`} onClick={() => remove(x, keyOf(x))}>🗑</button>
            </div>
          ))}
          {ideas.length > 0 && <div className="msg-sched-head">Ideas to start from</div>}
          {ideas.map((s) => (
            <div key={s.name} className="msg-item-wrap">
              <button className="msg-item" onClick={() => startDraft(s)}>
                <b>＋ {s.name}</b>
                <span className="muted small">{describe({ ...BLANK, ...s }, properties)}</span>
              </button>
              <button type="button" className="msg-item-del" title="Remove this idea" aria-label={`Remove the idea ${s.name}`} onClick={() => saveHiddenIdeas([...hiddenIdeas, s.name])}>✕</button>
            </div>
          ))}
          {hiddenIdeas.length > 0 && <button type="button" className="msg-link small" onClick={() => saveHiddenIdeas([])}>Show removed ideas</button>}
        </aside>

        {!r ? <p className="muted msg-sched-empty">Pick a scheduled message, or start a new one.</p> : (
          <section className={`sp-card msg-sched${r.active ? '' : ' off'}`}>
            <div className="sp-top">
              <button className="secondary msg-back" onClick={() => setActiveKey(null)}>←</button>
              <input className="sp-name" placeholder="Name, e.g. Day-before check-in details" value={r.name} onChange={(e) => edit(key, { name: e.target.value })} />
              <label className="chk"><input type="checkbox" checked={r.active} onChange={(e) => edit(key, { active: e.target.checked })} /> Active</label>
            </div>

            <div className="msg-sched-row">
              <label className="msg-field">Event
                <select aria-label="Event" value={r.anchor} onChange={(e) => setEvent(e.target.value)}>
                  <option value="confirmed">Booking confirmed</option>
                  <option value="check_in">Check-in</option>
                  <option value="check_out">Check-out</option>
                </select>
              </label>
              <label className="msg-field">When to send
                <select aria-label="When to send" value={whenValue} onChange={(e) => edit(key, booked ? { offsetMinutes: Number(e.target.value) } : { offsetDays: Number(e.target.value) })}>
                  {whenChoices.map((v) => <option key={v} value={v}>{booked ? delayLabel(v) : dayLabel(v, r.anchor === 'check_out' ? 'check-out' : 'check-in')}</option>)}
                </select>
              </label>
              {!booked && (
                <label className="msg-field">Time
                  <input type="time" aria-label="Time" value={r.sendTime} onChange={(e) => edit(key, { sendTime: e.target.value })} />
                </label>
              )}
            </div>

            <div className="sp-units">
              <span className="sp-units-label">Properties:</span>
              <button type="button" className={`sp-unit${r.noProperties ? ' on' : ''}`} onClick={() => edit(key, { propertyIds: [], noProperties: true })}>None</button>
              <button type="button" className={`sp-unit${!r.noProperties && r.propertyIds.length === 0 ? ' on' : ''}`} onClick={() => edit(key, { propertyIds: [], noProperties: false })}>All</button>
              {properties.map((p) => {
                const on = r.propertyIds.includes(p.id);
                return <button key={p.id} type="button" className={`sp-unit${on ? ' on' : ''}`}
                  onClick={() => edit(key, { noProperties: false, propertyIds: on ? r.propertyIds.filter((x) => x !== p.id) : [...r.propertyIds, p.id] })}>{p.name}</button>;
              })}
            </div>

            <div className="msg-sched-row"><span className="msg-lbl">Message</span></div>
            {r.templateId
              ? <>
                  <p className="msg-preview small">{(template || {}).body}</p>
                  <button type="button" className="msg-link small" onClick={() => edit(key, { templateId: '', body: (template || {}).body || '' })}>Edit this message</button>
                </>
              : <textarea ref={bodyEl} className="msg-tpl-body" rows={9} placeholder="Hi [First Name], …" value={r.body} onChange={(e) => edit(key, { body: e.target.value })} />}
            <ShortcutWarning text={template ? template.body : r.body} shortcuts={shortcuts} />

            <div className="msg-send-row">
              <span className="muted small">{describe(r, properties)}{r.id ? ` · sent ${r.sentCount}×` : ' · nothing sends until you press Create'}</span>
              <span>
                <button className="secondary" onClick={() => remove(r, key)}>{r.id ? 'Delete' : 'Discard'}</button>{' '}
                <button disabled={!r.dirty} onClick={() => save(r)}>{!r.id ? 'Create' : r.dirty ? 'Save' : 'Saved ✓'}</button>
              </span>
            </div>
          </section>
        )}

        <ShortcutPanel shortcuts={shortcuts}
          onPick={r && !r.templateId ? (token) => insertInto(bodyEl.current, r.body, token, (body) => edit(key, { body })) : null}
          note={!r ? 'Open a message to add these to it. Each one fills in for the booking when sent.' : r.templateId ? 'Press Edit this message to add shortcuts to it.' : null} />
      </div>
      )}
    </>
  );
}
