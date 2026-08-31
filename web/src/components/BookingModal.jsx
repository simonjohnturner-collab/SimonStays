import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { prettyDate } from '../dates.js';
import { fmtR, centsToRand, randToCents } from '../money.js';

export default function BookingModal({ unit, booking, floating, units = [], groups = [], onClose, onSaved, onInvoice }) {
  const editing = !!booking;
  const isFloating = floating || (editing && !booking.unitId);

  const [guestName, setGuestName] = useState(booking?.guestName || '');
  const [checkIn, setCheckIn] = useState(booking?.checkIn?.slice(0, 10) || '');
  const [checkOut, setCheckOut] = useState(booking?.checkOut?.slice(0, 10) || '');
  const [cleaner, setCleaner] = useState(booking?.cleaner || '');
  const [comments, setComments] = useState(booking?.comments || '');
  const [allocateUnitId, setAllocateUnitId] = useState('');
  const [groupId, setGroupId] = useState(booking?.pricingGroupId || '');

  // Payment: paid / partial / unpaid
  const [paymentStatus, setPaymentStatus] = useState(booking?.paymentStatus || (booking?.paid ? 'paid' : 'unpaid'));
  const [amountOwing, setAmountOwing] = useState(booking?.amountOwingCents != null ? centsToRand(booking.amountOwingCents) : '');

  const [earlyCheckIn, setEarlyCheckIn] = useState(booking?.earlyCheckIn || false);
  const [lateCheckOut, setLateCheckOut] = useState(booking?.lateCheckOut || false);
  const [extraMattress, setExtraMattress] = useState(booking?.extraMattress || false);
  const [hairDryer, setHairDryer] = useState(booking?.hairDryer || false);

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

  function payload(extra = {}) {
    return {
      guestName, checkIn, checkOut, cleaner, comments,
      paymentStatus, amountOwingCents: paymentStatus === 'partial' ? randToCents(amountOwing) : null,
      earlyCheckIn, lateCheckOut, extraMattress, hairDryer,
      cleans: cleans.filter((c) => c.date || c.cleaner),
      ...(isFloating ? { pricingGroupId: groupId || null } : {}),
      ...extra,
    };
  }

  async function checkAvail() {
    if (!checkIn || !checkOut) { setMsg({ text: 'Pick both dates first.', kind: 'err' }); return; }
    setBusy(true); setMsg({ text: 'Checking channels live…', kind: 'muted' }); setConflicts(null);
    try {
      const r = await api.availability(unit.id, checkIn, checkOut);
      if (r.available) setMsg({ text: `✅ ${unit.name} is free ${prettyDate(checkIn)} → ${prettyDate(checkOut)}.`, kind: 'ok' });
      else { setMsg({ text: '⛔ Not available.', kind: 'err' }); setConflicts(r.conflicts); }
    } catch (e) { setMsg({ text: e.message, kind: 'err' }); }
    finally { setBusy(false); }
  }

  async function save(override) {
    if (!checkIn || !checkOut) { setMsg({ text: 'Pick both dates.', kind: 'err' }); return; }
    setBusy(true); setMsg(null); setConflicts(null);
    try {
      if (editing) {
        const extra = allocateUnitId ? { unitId: allocateUnitId } : {};
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
    if (!window.confirm('Delete this booking?')) return;
    setBusy(true);
    try { await api.deleteBooking(booking.id); onSaved(); }
    catch (e) { setMsg({ text: e.message, kind: 'err' }); setBusy(false); }
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

        <div className="row2">
          <label>Check-in<input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} /></label>
          <label>Check-out<input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></label>
        </div>
        {quote && (
          <div className="quote-hint">
            💲 Rate card: <b>{fmtR(quote.totalCents)}</b> · {quote.nights} night{quote.nights > 1 ? 's' : ''} @ {fmtR(quote.avgNightlyCents)}/night
            {quote.discountPercent ? ` · ${quote.discountPercent}% discount` : ''}
            {quote.cleaningCents ? ` · clean ${fmtR(quote.cleaningCents)}` : ''}
            {quote.breakageCents ? ` · breakage ${fmtR(quote.breakageCents)}` : ''}
          </div>
        )}

        <label>Guest<input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Guest name" /></label>

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
          <div className="checks wrap">
            <label className="chk"><input type="radio" name="pay" checked={paymentStatus === 'paid'} onChange={() => setPaymentStatus('paid')} /> Paid</label>
            <label className="chk"><input type="radio" name="pay" checked={paymentStatus === 'partial'} onChange={() => setPaymentStatus('partial')} /> Partially paid</label>
            <label className="chk"><input type="radio" name="pay" checked={paymentStatus === 'unpaid'} onChange={() => setPaymentStatus('unpaid')} /> Unpaid (owing)</label>
          </div>
          {paymentStatus === 'partial' && (
            <label>Amount still owing (R)<input value={amountOwing} onChange={(e) => setAmountOwing(e.target.value)} placeholder="0.00" /></label>
          )}
          {paymentStatus !== 'paid' && <p className="muted small" style={{ color: 'var(--red)' }}>Money owing — the guest name shows red on the board.</p>}
        </fieldset>

        <fieldset>
          <legend>Requests & add-ons</legend>
          <div className="checks wrap">
            <label className="chk"><input type="checkbox" checked={earlyCheckIn} onChange={(e) => setEarlyCheckIn(e.target.checked)} /> Early check-in</label>
            <label className="chk"><input type="checkbox" checked={lateCheckOut} onChange={(e) => setLateCheckOut(e.target.checked)} /> Late check-out</label>
            <label className="chk"><input type="checkbox" checked={extraMattress} onChange={(e) => setExtraMattress(e.target.checked)} /> Extra mattress</label>
            <label className="chk"><input type="checkbox" checked={hairDryer} onChange={(e) => setHairDryer(e.target.checked)} /> Hair dryer</label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Cleaning</legend>
          <label>Checkout cleaner<input value={cleaner} onChange={(e) => setCleaner(e.target.value)} placeholder="Cleaner for the checkout clean" /></label>
          <div className="insta-head">
            <span>Insta cleans (mid-stay)</span>
            <button type="button" className="mini" onClick={addClean}>+ Add insta clean</button>
          </div>
          {cleans.length === 0 && <p className="muted small">None. Add one or more mid-stay cleans if the guest wants them.</p>}
          {cleans.map((c, i) => (
            <div key={i} className="insta-row">
              <input type="date" value={c.date} onChange={(e) => updateClean(i, 'date', e.target.value)} title="Clean date" />
              <select value={c.paymentMethod} onChange={(e) => updateClean(i, 'paymentMethod', e.target.value)} title="Payment">
                <option value="prepaid">Paid for</option>
                <option value="direct">Cleaner paid directly</option>
              </select>
              <input value={c.cleaner} onChange={(e) => updateClean(i, 'cleaner', e.target.value)} placeholder="Cleaner" title="Cleaner" />
              <button type="button" className="del sm" onClick={() => removeClean(i)} title="Remove">×</button>
            </div>
          ))}
        </fieldset>

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

        <div className="modal-actions">
          {editing && <button className="danger ghost" disabled={busy} onClick={remove}>Delete</button>}
          {editing && onInvoice && <button className="secondary" disabled={busy} onClick={() => onInvoice(booking)}>🧾 Invoice</button>}
          <div className="spacer" />
          {!isFloating && <button className="secondary" disabled={busy} onClick={checkAvail}>Check availability</button>}
          <button disabled={busy} onClick={() => save(false)}>{editing ? 'Save' : 'Create booking'}</button>
        </div>
      </div>
    </div>
  );
}
