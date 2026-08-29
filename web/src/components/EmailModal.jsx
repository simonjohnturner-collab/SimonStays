import { useState } from 'react';
import { api } from '../api.js';

// Paste (or, in production, auto-forward) an Airbnb reservation email. We pull the
// reservation code + guest name and back-fill the matching booking on the board.
export default function EmailModal({ onClose, onDone }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!subject && !body) { setMsg({ kind: 'err', text: 'Paste the email first.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await api.ingestEmail(subject, body);
      setMsg({ kind: 'ok', text: `Matched ${r.guestName} (${r.resCode}) — updated ${r.updatedBookings} booking(s).` });
      onDone && onDone();
    } catch (e) {
      const map = {
        no_reservation_code_found: 'Couldn’t find an Airbnb reservation code (HM…) in that email.',
        no_guest_name_found: 'Found the code but not a guest name — paste the full email including the subject line.',
        email_required: 'Paste the email first.',
      };
      setMsg({ kind: 'err', text: map[e.message] || e.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Add guest name from Airbnb email</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>

        <div className="direction-note">
          Airbnb’s calendar has no guest name — but its <b>reservation email</b> does, with the same code.
          Paste one here and we’ll fill in the board. <br />
          <span className="muted small">Production: auto-forward Airbnb mail from Outlook to your SimonStays address and this happens automatically.</span>
        </div>

        <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Reservation confirmed - Kevin arrives…" /></label>
        <label>Email body (paste)
          <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Paste the whole email — it contains the reservation URL with the HM… code." />
        </label>

        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

        <div className="modal-actions">
          <div className="spacer" />
          <button className="secondary" onClick={onClose}>Close</button>
          <button disabled={busy} onClick={submit}>{busy ? '…' : 'Match guest name'}</button>
        </div>
      </div>
    </div>
  );
}
