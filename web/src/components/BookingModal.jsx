import { useState } from 'react';
import { api } from '../api.js';
import { prettyDate } from '../dates.js';

export default function BookingModal({ unit, booking, onClose, onSaved }) {
  const editing = !!booking;
  const [guestName, setGuestName] = useState(booking?.guestName || '');
  const [checkIn, setCheckIn] = useState(booking?.checkIn?.slice(0, 10) || '');
  const [checkOut, setCheckOut] = useState(booking?.checkOut?.slice(0, 10) || '');
  const [cleaner, setCleaner] = useState(booking?.cleaner || '');
  const [comments, setComments] = useState(booking?.comments || '');

  // Payment + requests / add-ons
  const [paid, setPaid] = useState(booking?.paid || false);
  const [earlyCheckIn, setEarlyCheckIn] = useState(booking?.earlyCheckIn || false);
  const [lateCheckOut, setLateCheckOut] = useState(booking?.lateCheckOut || false);
  const [extraCleaning, setExtraCleaning] = useState(booking?.extraCleaning || false);
  const [extraCleaningPaid, setExtraCleaningPaid] = useState(booking?.extraCleaningPaid || false);
  const [extraMattress, setExtraMattress] = useState(booking?.extraMattress || false);
  const [hairDryer, setHairDryer] = useState(booking?.hairDryer || false);

  const [msg, setMsg] = useState(null); // { text, kind }
  const [conflicts, setConflicts] = useState(null);
  const [busy, setBusy] = useState(false);

  function payload(extra = {}) {
    return {
      guestName, checkIn, checkOut, cleaner, comments,
      paid, earlyCheckIn, lateCheckOut,
      extraCleaning, extraCleaningPaid: extraCleaning ? extraCleaningPaid : false,
      extraMattress, hairDryer, ...extra,
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
      if (editing) await api.updateBooking(booking.id, payload());
      else await api.createBooking(unit.id, payload({ override: !!override }));
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

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{editing ? 'Edit booking' : 'New booking'} · {unit.name}</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>

        {editing && booking.source !== 'manual' && (
          <div className="chip-note">From {booking.source} — dates come from the channel; edits here won't push back.</div>
        )}

        <div className="row2">
          <label>Check-in<input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} /></label>
          <label>Check-out<input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></label>
        </div>
        <label>Guest<input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Guest name" /></label>

        <fieldset>
          <legend>Payment</legend>
          <label className="chk"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Booking paid for</label>
        </fieldset>

        <fieldset>
          <legend>Requests & add-ons</legend>
          <div className="checks wrap">
            <label className="chk"><input type="checkbox" checked={earlyCheckIn} onChange={(e) => setEarlyCheckIn(e.target.checked)} /> Early check-in</label>
            <label className="chk"><input type="checkbox" checked={lateCheckOut} onChange={(e) => setLateCheckOut(e.target.checked)} /> Late check-out</label>
            <label className="chk"><input type="checkbox" checked={extraMattress} onChange={(e) => setExtraMattress(e.target.checked)} /> Extra mattress</label>
            <label className="chk"><input type="checkbox" checked={hairDryer} onChange={(e) => setHairDryer(e.target.checked)} /> Hair dryer</label>
          </div>
          <div className="checks">
            <label className="chk"><input type="checkbox" checked={extraCleaning} onChange={(e) => setExtraCleaning(e.target.checked)} /> Additional cleaning</label>
            <label className={`chk ${extraCleaning ? '' : 'disabled'}`}>
              <input type="checkbox" disabled={!extraCleaning} checked={extraCleaning && extraCleaningPaid} onChange={(e) => setExtraCleaningPaid(e.target.checked)} /> Additional cleaning paid
            </label>
          </div>
        </fieldset>

        <label>Cleaner<input value={cleaner} onChange={(e) => setCleaner(e.target.value)} placeholder="Optional" /></label>
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
          <div className="spacer" />
          <button className="secondary" disabled={busy} onClick={checkAvail}>Check availability</button>
          <button disabled={busy} onClick={() => save(false)}>{editing ? 'Save' : 'Create booking'}</button>
        </div>
      </div>
    </div>
  );
}
