import { useState, useEffect } from 'react';
import { api, apiBaseUrl, getToken } from '../api.js';
import { fmtR, centsToRand, randToCents } from '../money.js';
import { GuestRatingChip } from './RatingsView.jsx';

export default function BookingModal({ unit, booking, floating, units = [], groups = [], cleaners = [], onClose, onSaved, onInvoice, onMessage }) {
  const editing = !!booking;
  const isFloating = floating || (editing && !booking.unitId);
  const [guestRating, setGuestRating] = useState(undefined);
  useEffect(() => {
    if (editing && (booking.guestEmail || booking.guestAccountId)) api.guestRating(booking.id).then((r) => setGuestRating(r.rating)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [guestName, setGuestName] = useState(booking?.guestName || '');
  const [guestEmail, setGuestEmail] = useState(booking?.guestEmail || '');
  const [guestPhone, setGuestPhone] = useState(booking?.guestPhone || '');
  const [checkIn, setCheckIn] = useState(booking?.checkIn?.slice(0, 10) || '');
  const [checkOut, setCheckOut] = useState(booking?.checkOut?.slice(0, 10) || '');
  const [cleaner, setCleaner] = useState(booking?.cleaner || '');
  const [comments, setComments] = useState(booking?.comments || '');
  const [checkoutNotes, setCheckoutNotes] = useState(booking?.checkoutNotes || '');
  const [recommendedBy, setRecommendedBy] = useState(booking?.recommendedBy || '');
  const [allocateUnitId, setAllocateUnitId] = useState('');
  const [moveUnitId, setMoveUnitId] = useState(booking?.unitId || ''); // reassign an allocated booking to another unit
  const [groupId, setGroupId] = useState(booking?.pricingGroupId || '');

  // Payment: paid / partial / unpaid, plus the quoted amount and what's been paid.
  const [paymentStatus, setPaymentStatus] = useState(booking?.paymentStatus || (booking?.paid ? 'paid' : 'unpaid'));
  // Kept as text (the inputs' value) — centsToRand returns a number, and .trim() below needs a string.
  const [quoted, setQuoted] = useState(booking?.quotedCents != null ? centsToRand(booking.quotedCents).toFixed(2) : '');
  const [amountPaid, setAmountPaid] = useState(booking?.amountPaidCents != null ? centsToRand(booking.amountPaidCents).toFixed(2) : '');

  const [earlyCheckIn, setEarlyCheckIn] = useState(booking?.earlyCheckIn || false);
  const [lateCheckOut, setLateCheckOut] = useState(booking?.lateCheckOut || false);
  const [extraMattress, setExtraMattress] = useState(booking?.extraMattress || false);
  const [hairDryer, setHairDryer] = useState(booking?.hairDryer || false);
  const addonCount = [earlyCheckIn, lateCheckOut, extraMattress, hairDryer].filter(Boolean).length;
  const [tab, setTab] = useState('guest');
  const [gbLinked, setGbLinked] = useState(!!booking?.guestbookVerified);

  const [cleans, setCleans] = useState(
    (booking?.cleans || []).map((c) => ({ date: c.date?.slice(0, 10) || '', paymentMethod: c.paymentMethod || 'prepaid', cleaner: c.cleaner || '' }))
  );
  const addClean = () => setCleans([...cleans, { date: '', paymentMethod: 'prepaid', cleaner: '' }]);
  const updateClean = (i, field, val) => setCleans(cleans.map((c, j) => (j === i ? { ...c, [field]: val } : c)));
  const removeClean = (i) => setCleans(cleans.filter((_, j) => j !== i));
  // Mid-stay cleans the guest asked for in the guestbook, kept off the calendar
  // until the host adds them (once paid). Saving after adding clears the request.
  const [requested, setRequested] = useState(Array.isArray(booking?.requestedCleans) ? booking.requestedCleans : []);
  const [requestDone, setRequestDone] = useState(false);
  const addRequested = () => {
    const have = new Set(cleans.map((c) => c.date));
    setCleans([...cleans, ...requested.filter((d) => !have.has(d)).map((date) => ({ date, paymentMethod: 'prepaid', cleaner: '' }))]);
    setRequested([]); setRequestDone(true);
  };
  const dismissRequested = () => { setRequested([]); setRequestDone(true); };

  const [msg, setMsg] = useState(null);
  const [conflicts, setConflicts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState(null);

  // Live rate-card price (only for a real unit).
  useEffect(() => {
    let cancelled = false;
    if (!checkIn || !checkOut || !unit?.id) { setQuote(null); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.quoteUnit(unit.id, { checkIn, checkOut, mattress: extraMattress, earlyCheckIn, lateCheckOut, cleans: 1 });
        if (!cancelled) setQuote(r.quote);
      } catch { if (!cancelled) setQuote(null); }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [checkIn, checkOut, extraMattress, earlyCheckIn, lateCheckOut, unit?.id]);

  // Three amounts: what the pricing schedule calculates, what we actually quoted,
  // and what's been paid. Outstanding = quoted − paid (only shown when there's a balance).
  const calcCents = quote ? quote.totalCents : null;
  const effQuotedCents = String(quoted).trim() ? randToCents(quoted) : calcCents; // typed quote, else the calc
  const paidCents = paymentStatus === 'partial' ? (String(amountPaid).trim() ? randToCents(amountPaid) : 0) : 0;
  const outstandingCents = effQuotedCents == null ? null
    : paymentStatus === 'paid' ? 0
    : paymentStatus === 'unpaid' ? effQuotedCents
    : Math.max(0, effQuotedCents - paidCents);

  function payload(extra = {}) {
    return {
      guestName, checkIn, checkOut, cleaner, comments,
      guestEmail: guestEmail.trim() || null,
      guestPhone: guestPhone.trim() || null,
      checkoutNotes: checkoutNotes.trim() || null,
      recommendedBy: recommendedBy.trim() || null,
      paymentStatus,
      quotedCents: effQuotedCents,
      amountPaidCents: paymentStatus === 'partial' ? paidCents : null,
      earlyCheckIn, lateCheckOut, extraMattress, hairDryer,
      cleans: cleans.filter((c) => c.date || c.cleaner),
      ...(requestDone ? { requestedCleans: null } : {}),
      ...(isFloating ? { pricingGroupId: groupId || null } : {}),
      ...extra,
    };
  }

  async function save(override) {
    if (!checkIn || !checkOut) { setMsg({ text: 'Pick both dates.', kind: 'err' }); return; }
    setBusy(true); setMsg(null); setConflicts(null);
    try {
      if (editing) {
        const extra = {};
        if (isFloating) { if (allocateUnitId) extra.unitId = allocateUnitId; }
        else if (moveUnitId && moveUnitId !== booking.unitId) extra.unitId = moveUnitId; // moved to another unit
        await api.updateBooking(booking.id, payload(extra));
      } else if (isFloating) {
        await api.createFloating(payload());
      } else {
        await api.createBooking(unit.id, payload({ override: !!override }));
      }
      onSaved();
    } catch (e) {
      if (e.status === 409 && e.data?.conflicts) {
        setMsg({ text: '⛔ Those dates clash on this unit.', kind: 'err' });
        setConflicts(e.data.conflicts);
      } else setMsg({ text: e.message, kind: 'err' });
    } finally { setBusy(false); }
  }

  // The EFT has reached the host's account: block the dates and tell the guest.
  async function confirmPaid() {
    const amount = effQuotedCents != null ? ` of ${fmtR(effQuotedCents)}` : '';
    if (!window.confirm(`Has the payment${amount} reached your account${booking.ref ? `, with reference ${booking.ref}` : ''}?\n\nConfirming blocks these dates and tells the guest their booking is confirmed. Any proof of payment they've sent is in Messages.`)) return;
    setBusy(true); setMsg(null); setConflicts(null);
    try { await api.confirmBooking(booking.id); onSaved(); }
    catch (e) {
      setMsg({ text: e.message, kind: 'err' });
      if (e.data?.conflicts) setConflicts(e.data.conflicts);
      setBusy(false);
    }
  }

  async function remove() {
    const paidCents = booking.amountPaidCents || 0;
    const q = booking.source === 'website'
      ? `Cancel this SimonStays booking? The dates are freed and it's kept as "cancelled" for your records.${paidCents ? `\n\nThe guest has paid ${fmtR(paidCents)} — refund them separately.` : ''}`
      : 'Cancel this booking?';
    if (!window.confirm(q)) return;
    setBusy(true);
    try { await api.deleteBooking(booking.id); onSaved(); }
    catch (e) { setMsg({ text: e.message, kind: 'err' }); setBusy(false); }
  }

  // Un-allocate: send the allocated booking back to floating (frees the channel).
  async function makeFloating() {
    if (!window.confirm('Send this booking back to floating? It will stop blocking this unit / channel.')) return;
    setBusy(true);
    try { await api.updateBooking(booking.id, { unitId: null }); onSaved(); }
    catch (e) { setMsg({ text: e.message, kind: 'err' }); setBusy(false); }
  }

  // Save the latest cleaner + checkout notes, then WhatsApp the reminder now
  // (without closing the modal, so the host sees the result).
  async function remindCleaner() {
    setBusy(true); setMsg(null);
    try {
      await api.updateBooking(booking.id, { cleaner, checkoutNotes: checkoutNotes.trim() || null });
      const r = await api.remindCleaner(booking.id);
      setMsg({ text: `✅ WhatsApp reminder sent to ${r.cleaner || 'the cleaner'}${r.phone ? ` (${r.phone})` : ''}.`, kind: 'ok' });
    } catch (e) {
      setMsg({ text: (e.data && e.data.message) || e.message || 'Could not send the reminder.', kind: 'err' });
    } finally { setBusy(false); }
  }

  // The guestbook was filled in but the phone didn't match: the host links it once sure.
  async function linkGuestbook() {
    if (!window.confirm('Link this booking to the account that filled in the guestbook? They’ll see it in their trips, including the door code once it’s paid.')) return;
    setBusy(true); setMsg(null);
    try { await api.linkGuestbook(booking.id); setGbLinked(true); setMsg({ text: 'Linked. The guest can now see this stay in their trips.', kind: 'ok' }); }
    catch (e) { setMsg({ text: e.message, kind: 'err' }); } finally { setBusy(false); }
  }

  // The guest's WhatsApp confirmation, sent by hand: preview first, then send.
  const [waPreview, setWaPreview] = useState(null); // { preview, to } | { result } | { error }
  const waCall = async (method) => {
    const r = await fetch(`${apiBaseUrl().replace(/\/$/, '')}/bookings/${booking.id}/whatsapp-confirmation`, { method, headers: { Authorization: `Bearer ${getToken()}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
    return d;
  };
  async function previewGuestWhatsApp() {
    setBusy(true); setWaPreview(null);
    try {
      if ((booking.guestPhone || '') !== guestPhone.trim()) await api.updateBooking(booking.id, { guestPhone: guestPhone.trim() || null });
      setWaPreview(await waCall('GET'));
    } catch (e) { setWaPreview({ error: e.message }); } finally { setBusy(false); }
  }
  async function sendGuestWhatsApp() {
    setBusy(true);
    try { const r = await waCall('POST'); setWaPreview((p) => ({ ...p, result: r })); }
    catch (e) { setWaPreview((p) => ({ ...p, result: { ok: false, message: e.message } })); } finally { setBusy(false); }
  }
  const WA_DONE = { delivered: '✅ Delivered to the guest’s WhatsApp', read: '✅ Delivered and read', sent: '📤 Sent. WhatsApp hasn’t confirmed delivery yet', queued: '📤 Queued', failed: '❌ Not delivered', undelivered: '❌ Not delivered', rejected: '❌ Twilio refused it' };

  const title = `${editing ? 'Edit' : 'New'} ${isFloating ? 'floating booking' : 'booking'}${unit ? ` · ${unit.name}` : ''}`;
  const nights = checkIn && checkOut ? Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000) : 0;
  const SOURCE = { manual: 'Direct', website: 'SimonStays', airbnb: 'Airbnb', booking: 'Booking.com', lekkeslaap: 'LekkeSlaap', import: 'Imported' };
  const sourceLabel = editing ? (SOURCE[booking.source] || booking.source) : null;
  const payPill = paymentStatus === 'paid' ? { cls: 'ok', text: 'Paid' }
    : { cls: 'owe', text: outstandingCents ? `Owing ${fmtR(outstandingCents)}` : paymentStatus === 'partial' ? 'Part paid' : 'Unpaid' };
  const cleanCount = (cleaner ? 1 : 0) + cleans.length + requested.length;
  const TABS = [
    ['guest', 'Guest'],
    ['pay', 'Payment'],
    ['extras', `Extras${addonCount ? ` · ${addonCount}` : ''}`],
    ['clean', `Cleaning${cleanCount ? ` · ${cleanCount}` : ''}`],
  ];

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal bm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>

        <div className="bm-pills">
          {sourceLabel && <span className="bm-pill">{sourceLabel}</span>}
          {editing && booking.resCode && <code className="bm-code" title="Confirmation code: click to select, then copy">{booking.resCode}</code>}
          {editing && booking.ref && !booking.resCode && <code className="bm-code" title="Booking reference">{booking.ref}</code>}
          {editing && booking.status === 'pending' && <span className="bm-pill owe">Awaiting payment</span>}
          <span className={`bm-pill ${payPill.cls}`}>{payPill.text}</span>
          {nights > 0 && <span className="bm-pill">{nights} night{nights > 1 ? 's' : ''}</span>}
          {editing && booking.guestbookAt && <span className={`bm-pill ${gbLinked ? 'ok' : 'warn'}`} title={gbLinked ? 'The guest filled in the guestbook' : 'Filled in, but the phone didn’t match Airbnb’s. Check it’s them, then link it on the Guest tab.'}>📒 Guestbook{gbLinked ? ' ✓' : ' · check'}</span>}
          {guestRating !== undefined && <GuestRatingChip rating={guestRating} />}
        </div>
        {isFloating && !allocateUnitId && <div className="bm-note">Floating: not on a unit yet, so it blocks nothing.</div>}
        {editing && !['manual', 'website'].includes(booking.source) && <div className="bm-note">Dates come from {sourceLabel}. Changes here don’t sync back.</div>}

        <label>Guest name<input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Guest name" /></label>
        <div className="bm-grid2">
          <label>Check-in<input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} /></label>
          <label>Check-out<input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></label>
        </div>
        {booking?.dayUse && <div className="muted small">Day use. Check-out shows the next morning so the clean falls then.</div>}

        <div className="bm-tabs" role="tablist">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>

        {tab === 'guest' && (
          <div className="bm-panel">
            <div className="bm-grid2">
              <label>Email<input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} placeholder="guest@example.com" /></label>
              <label>Phone<input type="tel" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} placeholder="082 123 4567" /></label>
            </div>
            {editing && booking.status === 'confirmed' && (
              <div className="wa-confirm">
                <button type="button" className="secondary" disabled={busy || !guestPhone.trim()} title={guestPhone.trim() ? '' : 'Add a phone number first'} onClick={previewGuestWhatsApp}>📲 WhatsApp confirmation</button>
                {waPreview && waPreview.error && <div className="wa-result bad">{waPreview.error}</div>}
                {waPreview && waPreview.preview && (
                  <div className="wa-preview">
                    <div className="muted small">What <b>{waPreview.to}</b> will get:</div>
                    <pre className="wa-bubble">{waPreview.preview}</pre>
                    {!waPreview.result ? (
                      <div className="wa-preview-btns">
                        <button type="button" disabled={busy} onClick={sendGuestWhatsApp}>{busy ? 'Sending…' : 'Send'}</button>
                        <button type="button" className="secondary" disabled={busy} onClick={() => setWaPreview(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div className={`wa-result ${waPreview.result.ok ? 'ok' : 'bad'}`}>
                        <b>{WA_DONE[waPreview.result.status] || (waPreview.result.ok ? 'Sent' : 'Not sent')}</b>
                        {!waPreview.result.ok && waPreview.result.message && <div className="muted small">{waPreview.result.errorCode ? `${waPreview.result.errorCode} · ` : ''}{waPreview.result.message}{waPreview.result.errorCode === 63016 ? ' — the guest template isn’t approved by WhatsApp yet.' : ''}</div>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {editing && !isFloating && booking.source === 'manual' && units.length > 0 && (
              <label>Unit
                <select value={moveUnitId} onChange={(e) => setMoveUnitId(e.target.value)}>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                </select>
              </label>
            )}
            {isFloating && (
              <div className="bm-grid2">
                <label>Show in group
                  <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                    <option value="">Floating row</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
                <label>Allocate to unit
                  <select value={allocateUnitId} onChange={(e) => setAllocateUnitId(e.target.value)}>
                    <option value="">Keep floating</option>
                    {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                  </select>
                </label>
              </div>
            )}

            {editing && booking.guestNotes && (
              <div className="bm-guestnote"><b>Guest’s instructions</b>{booking.guestNotes}</div>
            )}
            {editing && booking.guestbookAt && !gbLinked && (
              <div className="bm-note">Guestbook filled in, but the phone didn’t match Airbnb’s, so it isn’t linked to their account yet.{' '}
                <button type="button" className="mini" disabled={busy} onClick={linkGuestbook}>Link account</button></div>
            )}
            <div className="bm-grid2">
              <label>Referred by<input value={recommendedBy} onChange={(e) => setRecommendedBy(e.target.value)} placeholder="Who recommended them" /></label>
              <label>Notes<input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Anything else" /></label>
            </div>
          </div>
        )}

        {tab === 'pay' && (
          <div className="bm-panel">
            <div className="pay-calc">
              <span>Rate card</span>
              <b>{calcCents != null ? fmtR(calcCents) : '—'}</b>
              {quote && (
                <span className="muted small">{quote.nights} night{quote.nights > 1 ? 's' : ''} @ {fmtR(quote.avgNightlyCents)}
                  {quote.discountPercent ? ` · ${quote.discountPercent}% off` : ''}
                  {quote.cleaningCents ? ` · clean ${fmtR(quote.cleaningCents)}` : ''}</span>
              )}
            </div>
            <label>Amount charged (R)
              <input inputMode="decimal" value={quoted} onChange={(e) => setQuoted(e.target.value)} placeholder={calcCents != null ? String(centsToRand(calcCents)) : '0.00'} />
            </label>
            <div className="bm-seg" role="radiogroup" aria-label="Payment">
              {[['paid', 'Paid'], ['partial', 'Part paid'], ['unpaid', 'Unpaid']].map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={paymentStatus === k} className={paymentStatus === k ? `on ${k}` : ''} onClick={() => setPaymentStatus(k)}>{label}</button>
              ))}
            </div>
            {paymentStatus === 'partial' && (
              <div className="bm-grid2">
                <label>Paid so far (R)<input inputMode="decimal" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="0.00" /></label>
                <label>Outstanding<input className="ro" readOnly value={outstandingCents != null ? fmtR(outstandingCents) : '—'} /></label>
              </div>
            )}
            {paymentStatus === 'unpaid' && outstandingCents != null && <p className="pay-out">Outstanding: <b>{fmtR(outstandingCents)}</b></p>}
            {paymentStatus !== 'paid' && <p className="muted small">The guest’s name shows red on the board until it’s paid.</p>}
          </div>
        )}

        {tab === 'extras' && (
          <div className="bm-panel">
            <div className="bm-toggles">
              {[['Early check-in', earlyCheckIn, setEarlyCheckIn], ['Late check-out', lateCheckOut, setLateCheckOut], ['Extra mattress', extraMattress, setExtraMattress], ['Hair dryer', hairDryer, setHairDryer]].map(([label, on, set]) => (
                <button key={label} type="button" aria-pressed={on} className={on ? 'on' : ''} onClick={() => set(!on)}>{on ? '✓ ' : ''}{label}</button>
              ))}
            </div>
          </div>
        )}

        {tab === 'clean' && (
          <div className="bm-panel">
            <label>Checkout cleaner<input list="cleaner-names" value={cleaner} onChange={(e) => setCleaner(e.target.value)} placeholder="Choose or type a name" /></label>
            <label>Notes for the cleaner
              <textarea rows={2} value={checkoutNotes} onChange={(e) => setCheckoutNotes(e.target.value)} placeholder="e.g. Key in the lockbox · strip the sofa bed" /></label>
            {editing && booking.unitId && (
              <div className="remind-row">
                <button type="button" className="secondary" disabled={busy || !cleaner} onClick={remindCleaner}>📲 Remind cleaner now</button>
                <span className="muted small">Sends automatically at 7pm the night before.</span>
              </div>
            )}
            {requested.length > 0 && (
              <div className="bm-guestnote">
                <b>Guest asked for {requested.length} mid-stay clean{requested.length > 1 ? 's' : ''}</b>
                {requested.map((d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })).join(' · ')}
                <div className="bm-req-btns">
                  <button type="button" className="mini" onClick={addRequested}>Add to cleans (once paid)</button>
                  <button type="button" className="mini" onClick={dismissRequested}>Dismiss</button>
                </div>
              </div>
            )}
            <div className="insta-head">
              <span>Mid-stay cleans</span>
              <button type="button" className="mini" onClick={addClean}>+ Add</button>
            </div>
            {cleans.length === 0 && <p className="muted small">None.</p>}
            {cleans.map((c, i) => (
              <div key={i} className="insta-row">
                <input type="date" value={c.date} onChange={(e) => updateClean(i, 'date', e.target.value)} title="Clean date" />
                <select value={c.paymentMethod} onChange={(e) => updateClean(i, 'paymentMethod', e.target.value)} title="Payment">
                  <option value="prepaid">Paid for</option>
                  <option value="direct">Cleaner paid directly</option>
                </select>
                <input list="cleaner-names" value={c.cleaner} onChange={(e) => updateClean(i, 'cleaner', e.target.value)} placeholder="Cleaner" title="Cleaner" />
                <button type="button" className="del sm" onClick={() => removeClean(i)} title="Remove">×</button>
              </div>
            ))}
          </div>
        )}
        <datalist id="cleaner-names">{cleaners.map((c) => <option key={c} value={c} />)}</datalist>

        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
        {conflicts && (
          <div className="conflicts">
            <b>Clashes with:</b>
            <ul>{conflicts.map((c) => (
              <li key={c.id}>{c.guestName || 'Booking'} ({c.source}): {c.checkIn.slice(0, 10)} → {c.checkOut.slice(0, 10)}</li>
            ))}</ul>
            {!editing && <button className="danger" disabled={busy} onClick={() => save(true)}>Book anyway</button>}
          </div>
        )}

        <div className="bm-actions">
          {editing && (
            <div className="bm-actions-sub">
              {onInvoice && <button className="secondary" disabled={busy} onClick={() => onInvoice(booking)}>🧾 Invoice</button>}
              {booking.unitId && onMessage && <button className="secondary" disabled={busy} onClick={() => onMessage(booking)}>💬 Message</button>}
              {booking.unitId && booking.source === 'manual' && <button className="secondary" disabled={busy} onClick={makeFloating}>↩ Make floating</button>}
            </div>
          )}
          <div className="bm-actions-main">
            {editing && <button className="bm-cancel" disabled={busy} onClick={remove}>Cancel booking</button>}
            {editing && booking.status === 'pending' && <button className="save" disabled={busy} onClick={confirmPaid}>✅ Confirm</button>}
            <button className="save" disabled={busy} onClick={() => save(false)}>{editing ? 'Save' : 'Create booking'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
