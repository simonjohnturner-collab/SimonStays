import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { fmtR, centsToRand, randToCents } from '../money.js';

export default function BookingModal({ unit, booking, floating, units = [], groups = [], cleaners = [], onClose, onSaved, onInvoice }) {
  const editing = !!booking;
  const isFloating = floating || (editing && !booking.unitId);

  const [guestName, setGuestName] = useState(booking?.guestName || '');
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
  const [quoted, setQuoted] = useState(booking?.quotedCents != null ? centsToRand(booking.quotedCents) : '');
  const [amountPaid, setAmountPaid] = useState(booking?.amountPaidCents != null ? centsToRand(booking.amountPaidCents) : '');

  const [earlyCheckIn, setEarlyCheckIn] = useState(booking?.earlyCheckIn || false);
  const [lateCheckOut, setLateCheckOut] = useState(booking?.lateCheckOut || false);
  const [extraMattress, setExtraMattress] = useState(booking?.extraMattress || false);
  const [hairDryer, setHairDryer] = useState(booking?.hairDryer || false);
  const addonCount = [earlyCheckIn, lateCheckOut, extraMattress, hairDryer].filter(Boolean).length;
  const [addonsOpen, setAddonsOpen] = useState(addonCount > 0);

  const [cleans, setCleans] = useState(
    (booking?.cleans || []).map((c) => ({ date: c.date?.slice(0, 10) || '', paymentMethod: c.paymentMethod || 'prepaid', cleaner: c.cleaner || '' }))
  );
  const addClean = () => setCleans([...cleans, { date: '', paymentMethod: 'prepaid', cleaner: '' }]);
  const updateClean = (i, field, val) => setCleans(cleans.map((c, j) => (j === i ? { ...c, [field]: val } : c)));
  const removeClean = (i) => setCleans(cleans.filter((_, j) => j !== i));

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
  const effQuotedCents = quoted.trim() ? randToCents(quoted) : calcCents; // typed quote, else the calc
  const paidCents = paymentStatus === 'partial' ? (amountPaid.trim() ? randToCents(amountPaid) : 0) : 0;
  const outstandingCents = effQuotedCents == null ? null
    : paymentStatus === 'paid' ? 0
    : paymentStatus === 'unpaid' ? effQuotedCents
    : Math.max(0, effQuotedCents - paidCents);

  function payload(extra = {}) {
    return {
      guestName, checkIn, checkOut, cleaner, comments,
      checkoutNotes: checkoutNotes.trim() || null,
      recommendedBy: recommendedBy.trim() || null,
      paymentStatus,
      quotedCents: effQuotedCents,
      amountPaidCents: paymentStatus === 'partial' ? paidCents : null,
      earlyCheckIn, lateCheckOut, extraMattress, hairDryer,
      cleans: cleans.filter((c) => c.date || c.cleaner),
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

  async function remove() {
    if (!window.confirm('Cancel this booking?')) return;
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

  const title = `${editing ? 'Edit' : 'New'} ${isFloating ? 'floating booking' : 'booking'}${unit ? ` · ${unit.name}` : ''}`;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>

        {isFloating && !allocateUnitId && (
          <div className="chip-note">Floating booking — not tied to a unit, so it blocks nothing. Shown yellow until you allocate it.</div>
        )}
        {editing && booking.source !== 'manual' && (
          <div className="chip-note">From {booking.source} — dates come from the channel; edits here won't push back.</div>
        )}
        {editing && booking.resCode && (
          <div className="reslabel">Airbnb confirmation code&nbsp;<code title="Click to select, then copy">{booking.resCode}</code></div>
        )}

        <label>Guest<input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Guest name" /></label>

        <div className="row2">
          <label>Check-in<input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} /></label>
          <label>Check-out<input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></label>
        </div>
        {editing && !isFloating && booking.source === 'manual' && units.length > 0 && (
          <label>Move to a different unit <span className="muted small">(reassigns this booking &amp; blocks the new unit)</span>
            <select value={moveUnitId} onChange={(e) => setMoveUnitId(e.target.value)}>
              {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
        )}

        {isFloating && (
          <>
            <label>Property group <span className="muted small">(soft — shows on the first free unit in the group; does NOT block channels)</span>
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">— None (stays in the Floating row) —</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label>Allocate to a unit <span className="muted small">(hard — ends floating &amp; blocks that unit)</span>
              <select value={allocateUnitId} onChange={(e) => setAllocateUnitId(e.target.value)}>
                <option value="">— Keep floating —</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </label>
          </>
        )}

        <fieldset>
          <legend>Payment</legend>
          <div className="pay-calc">
            <span>Per pricing schedule</span>
            <b>{calcCents != null ? fmtR(calcCents) : '—'}</b>
            {quote && (
              <span className="muted small">{quote.nights} night{quote.nights > 1 ? 's' : ''} @ {fmtR(quote.avgNightlyCents)}
                {quote.discountPercent ? ` · ${quote.discountPercent}% off` : ''}
                {quote.cleaningCents ? ` · clean ${fmtR(quote.cleaningCents)}` : ''}</span>
            )}
          </div>
          <label>Quoted to the guest (R) <span className="muted small">(what you actually charge)</span>
            <input value={quoted} onChange={(e) => setQuoted(e.target.value)} placeholder={calcCents != null ? centsToRand(calcCents) : '0.00'} />
          </label>
          <div className="checks wrap">
            <label className="chk"><input type="radio" name="pay" checked={paymentStatus === 'paid'} onChange={() => setPaymentStatus('paid')} /> Paid</label>
            <label className="chk"><input type="radio" name="pay" checked={paymentStatus === 'partial'} onChange={() => setPaymentStatus('partial')} /> Partially paid</label>
            <label className="chk"><input type="radio" name="pay" checked={paymentStatus === 'unpaid'} onChange={() => setPaymentStatus('unpaid')} /> Unpaid (owing)</label>
          </div>
          {paymentStatus === 'partial' && (
            <div className="row2">
              <label>Amount paid (R)<input value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="0.00" /></label>
              <label>Still outstanding<input className="ro" readOnly value={outstandingCents != null ? fmtR(outstandingCents) : '—'} /></label>
            </div>
          )}
          {paymentStatus === 'unpaid' && outstandingCents != null && (
            <p className="pay-out">Outstanding: <b>{fmtR(outstandingCents)}</b></p>
          )}
          {paymentStatus !== 'paid' && <p className="muted small" style={{ color: 'var(--red)' }}>Money owing — the guest name shows red on the board.</p>}
        </fieldset>

        <details className="addons-block" open={addonsOpen} onToggle={(e) => setAddonsOpen(e.currentTarget.open)}>
          <summary>Requests &amp; add-ons{addonCount ? ` · ${addonCount} selected` : ''}</summary>
          <div className="checks wrap">
            <label className="chk"><input type="checkbox" checked={earlyCheckIn} onChange={(e) => setEarlyCheckIn(e.target.checked)} /> Early check-in</label>
            <label className="chk"><input type="checkbox" checked={lateCheckOut} onChange={(e) => setLateCheckOut(e.target.checked)} /> Late check-out</label>
            <label className="chk"><input type="checkbox" checked={extraMattress} onChange={(e) => setExtraMattress(e.target.checked)} /> Extra mattress</label>
            <label className="chk"><input type="checkbox" checked={hairDryer} onChange={(e) => setHairDryer(e.target.checked)} /> Hair dryer</label>
          </div>
        </details>

        <fieldset>
          <legend>Cleaning</legend>
          <label>Checkout cleaner<input list="cleaner-names" value={cleaner} onChange={(e) => setCleaner(e.target.value)} placeholder="Choose or type a cleaner" /></label>
          <datalist id="cleaner-names">{cleaners.map((c) => <option key={c} value={c} />)}</datalist>
          <label>Checkout notes <span className="muted small">(sent to the cleaner in the 7pm night-before WhatsApp reminder)</span>
            <textarea rows={2} value={checkoutNotes} onChange={(e) => setCheckoutNotes(e.target.value)} placeholder="e.g. Guest leaving a key in the lockbox · strip the sofa bed · extra bins out back" /></label>
          {editing && booking.unitId && (
            <div className="remind-row">
              <button type="button" className="secondary" disabled={busy || !cleaner} onClick={remindCleaner}>📲 Send cleaner reminder now</button>
              <span className="muted small">Otherwise it sends automatically at 7pm the night before checkout.</span>
            </div>
          )}
          <div className="insta-head">
            <span>In-stay cleans</span>
            <button type="button" className="mini" onClick={addClean}>+ Add in-stay clean</button>
          </div>
          {cleans.length === 0 && <p className="muted small">None. Add one or more mid-stay cleans if the guest wants them.</p>}
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
        </fieldset>

        <label>Recommended by <span className="muted small">(who referred this guest — so you can thank them)</span>
          <input value={recommendedBy} onChange={(e) => setRecommendedBy(e.target.value)} placeholder="Name of the person who recommended you" /></label>

        <label>Comments<input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Anything else…" /></label>

        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
        {conflicts && (
          <div className="conflicts">
            <b>Clashes with:</b>
            <ul>{conflicts.map((c) => (
              <li key={c.id}>{c.guestName || 'Booking'} ({c.source}): {c.checkIn.slice(0, 10)} → {c.checkOut.slice(0, 10)}</li>
            ))}</ul>
            {!editing && <button className="danger" disabled={busy} onClick={() => save(true)}>Book anyway (override)</button>}
          </div>
        )}

        <div className="booking-actions">
          {editing && <button className="danger ghost" disabled={busy} onClick={remove}>Cancel booking</button>}
          {editing && booking.unitId && booking.source === 'manual' && (
            <button className="secondary" disabled={busy} onClick={makeFloating}>↩ Make floating</button>
          )}
          {editing && onInvoice && <button className="secondary" disabled={busy} onClick={() => onInvoice(booking)}>🧾 Invoice</button>}
          <button className="save" disabled={busy} onClick={() => save(false)}>{editing ? 'Save' : 'Create booking'}</button>
        </div>
      </div>
    </div>
  );
}
