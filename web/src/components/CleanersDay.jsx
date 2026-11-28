import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Who's cleaning where on a day: checkout and in-stay cleans grouped by cleaner,
// with the start time, guest and notes. Step forward or back a day at a time.
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const hm = (t) => new Date(t).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' });
const fmtDay = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export default function CleanersDay({ onClose, onOpenUnit }) {
  const [date, setDate] = useState(null); // null = today (the server decides, in SAST)
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setErr('');
    api.cleaningDay(date).then((d) => { if (live) { setData(d); if (!date) setDate(d.date); } })
      .catch((e) => { if (live) setErr((e.data && e.data.message) || e.message); });
    return () => { live = false; };
  }, [date]);

  const shown = data && data.date === date ? data : null;
  const jobs = shown ? shown.jobs : [];
  const groups = {};
  jobs.forEach((j) => { const k = j.cleaner || ''; (groups[k] = groups[k] || []).push(j); });
  const names = Object.keys(groups).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  const isToday = shown && shown.date === shown.today;
  const rel = !shown ? '' : isToday ? 'Today' : shown.date === addDays(shown.today, 1) ? 'Tomorrow' : shown.date === addDays(shown.today, -1) ? 'Yesterday' : '';

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="ghost um-back" onClick={onClose} aria-label="Back to calendar">←</button>
        <span className="host um-title">Cleaners</span>
        <div className="spacer" />
        <button className="ghost um-backw" onClick={onClose}>← Calendar</button>
      </header>
      <div className="cd-wrap">
        <div className="cd-head">
          <button className="um-nav" aria-label="Previous day" disabled={!date} onClick={() => setDate(addDays(date, -1))}>‹</button>
          <div className="cd-day">
            <b>{date ? fmtDay(date) : 'Loading…'}</b>
            <span className="muted small">{rel}{rel && shown ? ' · ' : ''}{shown ? `${jobs.length} clean${jobs.length === 1 ? '' : 's'}` : ''}</span>
          </div>
          <button className="um-nav" aria-label="Next day" disabled={!date} onClick={() => setDate(addDays(date, 1))}>›</button>
        </div>
        {shown && !isToday && <div className="cd-today"><button className="um-today" onClick={() => setDate(shown.today)}>Back to today</button></div>}
        {err && <div className="msg-warn">{err}</div>}
        {!shown && !err && <p className="muted small">Loading…</p>}
        {shown && jobs.length === 0 && <p className="muted cd-empty">No cleans booked this day.</p>}
        {shown && names.map((name) => (
          <section key={name || 'none'} className={`cd-card${name ? '' : ' cd-none'}`}>
            <h3>{name ? `🧹 ${name}` : '⚠️ No cleaner allocated'} <span className="muted small">{groups[name].length} clean{groups[name].length === 1 ? '' : 's'}</span></h3>
            {groups[name].map((j) => (
              <button key={j.key} className="cd-job" onClick={() => onOpenUnit && j.unitId && onOpenUnit(j.unitId)}>
                <span className="cd-time">{j.time}</span>
                <span className="cd-main">
                  <b>{j.place}</b>
                  <span className={`cd-kind ${j.kind}`}>{j.label}</span>
                  <span className="small">👤 {j.guestName || '—'}{j.ref ? <span className="muted"> · {j.ref}</span> : null}</span>
                  {j.notes.map((n, i) => <span key={i} className="small cd-note">📋 {n}</span>)}
                  {j.timeFrom === 'notes' && <span className="muted small">Start time taken from the checkout notes.</span>}
                </span>
                {j.cleaner && (
                  <span className="cd-status small">
                    {j.arrivedAt ? <span className="cd-sent on">🟢 Arrived {hm(j.arrivedAt)}</span>
                      : j.alertedAt ? <span className="cd-late">🔴 Not arrived</span>
                        : j.nudgedAt ? <span className="cd-late">🟠 Late: asked if all is well</span> : null}
                    {j.reminded && <span className="cd-sent" title="The night-before WhatsApp was sent">✓ Reminded</span>}
                  </span>
                )}
              </button>
            ))}
          </section>
        ))}
        <p className="muted small">Cleaners get a WhatsApp at 19:00 the night before each clean with the guest, the kind of clean, the start time (10:00, or 13:30 after a late checkout, unless the checkout notes give a time), the notes and a link to their report. If anything changes overnight they get a summary at 06:30. On arrival they tap “I’ve arrived” in the report; 15 minutes late they’re asked if all is well, and at 30 minutes you’re told.</p>
      </div>
    </div>
  );
}
