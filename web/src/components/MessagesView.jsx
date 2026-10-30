import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Guest messaging. Three tabs:
//   Inbox      — one conversation per booking; send now, optionally from a saved message
//   Saved      — pre-typed messages (with {placeholders}) to reuse
//   Scheduled  — automatic messages sent at a time relative to each stay, per property
// Guests read and reply on the shopfront (simonstays.co.za → Messages) and get an email copy.
export default function MessagesView({ onClose, properties = [], initialBookingId = null, onUnreadChange }) {
  const [tab, setTab] = useState('inbox');
  const [templates, setTemplates] = useState([]);
  const [placeholders, setPlaceholders] = useState([]);

  const loadTemplates = () => api.listMessageTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
  useEffect(() => {
    loadTemplates();
    api.messageMeta().then((r) => setPlaceholders(r.placeholders)).catch(() => {});
  }, []);

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Guest messages</span>
        <div className="spacer" />
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="msg-tabs">
        <button className={tab === 'inbox' ? 'on' : ''} onClick={() => setTab('inbox')}>💬 Inbox</button>
        <button className={tab === 'saved' ? 'on' : ''} onClick={() => setTab('saved')}>📝 Saved messages</button>
        <button className={tab === 'scheduled' ? 'on' : ''} onClick={() => setTab('scheduled')}>⏰ Scheduled</button>
      </div>

      {tab === 'inbox' && <Inbox templates={templates} initialBookingId={initialBookingId} onUnreadChange={onUnreadChange} />}
      {tab === 'saved' && <SavedMessages templates={templates} placeholders={placeholders} onChanged={loadTemplates} />}
      {tab === 'scheduled' && <Scheduled templates={templates} properties={properties} />}
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

// ---------------- Inbox ----------------

function Inbox({ templates, initialBookingId, onUnreadChange }) {
  const [threads, setThreads] = useState(null);
  const [activeId, setActiveId] = useState(initialBookingId);
  const [thread, setThread] = useState(null); // { booking, messages }
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [picking, setPicking] = useState(false);
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
  useEffect(() => { setThread(null); setDraft(''); setNote(''); if (activeId) loadThread(activeId); /* eslint-disable-next-line */ }, [activeId]);
  useEffect(() => { endRef.current && endRef.current.scrollIntoView({ block: 'end' }); }, [thread]);
  useEffect(() => {
    if (!picking) return;
    const t = setTimeout(() => api.messageRecipients(q).then((r) => setRecipients(r.bookings)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [picking, q]);

  async function insertTemplate(id) {
    const t = templates.find((x) => x.id === id);
    if (!t || !activeId) return;
    try { const r = await api.renderMessage(activeId, t.body); setDraft((d) => (d.trim() ? `${d}\n\n${r.body}` : r.body)); }
    catch { setDraft((d) => (d.trim() ? `${d}\n\n${t.body}` : t.body)); }
  }
  async function send() {
    if (!draft.trim() || !activeId) return;
    setBusy(true); setNote('');
    try {
      const r = await api.sendMessage(activeId, draft);
      setDraft('');
      setNote(r.emailed ? 'Sent — and emailed to the guest.' : 'Sent. (No email copy — the guest will see it when they sign in.)');
      await Promise.all([loadThread(activeId), loadThreads()]);
    } catch (e) { setNote((e.data && e.data.message) || e.message); }
    finally { setBusy(false); }
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
            <span className="msg-item-top"><b>{t.booking.guestName || 'Guest'}</b>{t.unread > 0 && <span className="msg-dot">{t.unread}</span>}</span>
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
              <div>
                <b>{b.guestName || 'Guest'}</b>{b.ref ? <span className="muted small"> · {b.ref}</span> : null}
                <div className="muted small">{placeOf(b)} · {fmtDay(b.checkIn)} → {fmtDay(b.checkOut)}{b.guestEmail ? ` · ${b.guestEmail}` : ''}</div>
              </div>
            </div>
            {!b.reachable && (
              <div className="msg-warn">This booking has no guest email or SimonStays account, so nobody will see these messages. Add the guest’s email on the booking first.</div>
            )}
            <div className="msg-bubbles">
              {thread.messages.length === 0 && <p className="muted small center">No messages yet.</p>}
              {thread.messages.map((m) => (
                <div key={m.id} className={`msg-bubble ${m.sender}`}>
                  {m.scheduleName && <div className="msg-auto">⏰ {m.scheduleName}</div>}
                  <div className="msg-body">{m.body}</div>
                  <div className="msg-meta">{fmtWhen(m.createdAt)}{m.sender === 'host' ? (m.readAt ? ' · Read' : m.emailedAt ? ' · Emailed' : '') : ''}</div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
            <div className="msg-compose">
              {templates.length > 0 && (
                <select value="" onChange={(e) => insertTemplate(e.target.value)}>
                  <option value="">📝 Insert a saved message…</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              <textarea rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write to the guest…" />
              <div className="msg-send-row">
                <span className="muted small">{note}</span>
                <button disabled={busy || !draft.trim()} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// ---------------- Saved messages ----------------

function PlaceholderChips({ placeholders, onPick }) {
  return (
    <div className="msg-chips">
      <span className="muted small">Fill in per booking:</span>
      {placeholders.map((p) => <button key={p} type="button" className="mini" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(`{${p}}`)}>{`{${p}}`}</button>)}
    </div>
  );
}

// Insert text at the cursor of a textarea and return the new value.
function insertAt(el, value, text) {
  if (!el) return value + text;
  const s = el.selectionStart ?? value.length, e = el.selectionEnd ?? value.length;
  return value.slice(0, s) + text + value.slice(e);
}

function SavedMessages({ templates, placeholders, onChanged }) {
  const [rows, setRows] = useState(templates);
  const [nw, setNw] = useState({ name: '', body: '' });
  const [msg, setMsg] = useState('');
  const focused = useRef(null); // { id, el } — the textarea a placeholder chip inserts into
  useEffect(() => setRows(templates), [templates]);
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1600); };

  function pick(token) {
    const f = focused.current;
    if (!f || f.id === 'new') setNw((n) => ({ ...n, body: insertAt(f && f.el, n.body, token) }));
    else setRows((rs) => rs.map((r) => (r.id === f.id ? { ...r, body: insertAt(f.el, r.body, token), dirty: true } : r)));
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
    <div className="gb-wrap">
      <p className="muted small">Pre-typed messages you can drop into a conversation or send on a schedule. Placeholders like <code>{'{firstName}'}</code> are filled in for each booking when it’s sent. {msg && <b>{msg}</b>}</p>
      <PlaceholderChips placeholders={placeholders} onPick={pick} />

      <section className="sp-card">
        <input className="sp-name" placeholder="Name, e.g. Check-in instructions" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} />
        <textarea className="msg-tpl-body" rows={5} placeholder={'Hi {firstName}, welcome to {property}! Check-in is from {checkInTime}…'} value={nw.body}
          onFocus={(e) => { focused.current = { id: 'new', el: e.target }; }} onChange={(e) => setNw({ ...nw, body: e.target.value })} />
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
        </section>
      ))}
    </div>
  );
}

// ---------------- Scheduled messages ----------------

const BLANK = { id: null, name: '', templateId: '', body: '', anchor: 'check_in', offsetDays: -1, sendTime: '10:00', propertyIds: [], active: true };

function describe(s, properties) {
  let when;
  if (s.anchor === 'confirmed') when = 'As soon as a booking is confirmed';
  else {
    const n = Math.abs(s.offsetDays), what = s.anchor === 'check_out' ? 'check-out' : 'check-in';
    when = (s.offsetDays === 0 ? `On ${what} day` : `${n} day${n === 1 ? '' : 's'} ${s.offsetDays < 0 ? 'before' : 'after'} ${what}`) + ` at ${s.sendTime}`;
  }
  const props = s.propertyIds.length ? properties.filter((p) => s.propertyIds.includes(p.id)).map((p) => p.name).join(', ') : 'all properties';
  return `${when} · ${props}`;
}

function Scheduled({ templates, properties }) {
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1800); };
  const load = () => api.listMessageSchedules().then((r) => setRows(r.schedules.map((s) => ({ ...s, templateId: s.templateId || '', body: s.body || '' })))).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);

  const keyOf = (r) => r.id || r._key;
  const edit = (key, patch) => setRows((rs) => rs.map((r) => (keyOf(r) === key ? { ...r, ...patch, dirty: true } : r)));

  async function save(r) {
    const data = { name: r.name, templateId: r.templateId || null, body: r.templateId ? null : r.body, anchor: r.anchor,
      offsetDays: r.offsetDays, sendTime: r.sendTime, propertyIds: r.propertyIds, active: r.active };
    try {
      if (r.id) await api.updateMessageSchedule(r.id, data); else await api.createMessageSchedule(data);
      await load(); flash('Saved.');
    } catch (e) { setMsg((e.data && e.data.message) || e.message); }
  }
  async function remove(r, key) {
    if (!r.id) { setRows((rs) => rs.filter((x) => keyOf(x) !== key)); return; }
    if (!window.confirm(`Delete the scheduled message “${r.name}”?`)) return;
    try { await api.deleteMessageSchedule(r.id); await load(); } catch (e) { setMsg(e.message); }
  }

  if (!rows) return <div className="gb-wrap"><p className="muted small">Loading…</p></div>;
  return (
    <div className="gb-wrap">
      <p className="muted small">
        Automatic messages go to every confirmed booking that matches — once per booking — and are emailed to the guest too.
        Only bookings with a guest email or SimonStays account receive them. {msg && <b>{msg}</b>}
      </p>
      <button onClick={() => setRows([{ ...BLANK, _key: `new${Date.now()}`, dirty: true }, ...rows])}>➕ New scheduled message</button>

      {rows.length === 0 && <p className="muted small">None yet. Typical ones: a welcome on confirmation, check-in details the day before, a checkout reminder the evening before.</p>}
      {rows.map((r) => {
        const key = keyOf(r);
        const dir = r.offsetDays < 0 ? 'before' : r.offsetDays > 0 ? 'after' : 'on';
        const n = Math.abs(r.offsetDays);
        const setOffset = (d, num) => edit(key, { offsetDays: d === 'on' ? 0 : (d === 'before' ? -1 : 1) * Math.max(1, num || 1) });
        return (
          <section key={key} className={`sp-card msg-sched${r.active ? '' : ' off'}`}>
            <div className="sp-top">
              <input className="sp-name" placeholder="Name, e.g. Day-before check-in details" value={r.name} onChange={(e) => edit(key, { name: e.target.value })} />
              <label className="chk"><input type="checkbox" checked={r.active} onChange={(e) => edit(key, { active: e.target.checked })} /> Active</label>
            </div>

            <div className="msg-sched-row">
              <span className="msg-lbl">Send</span>
              <select value={r.anchor === 'confirmed' ? 'confirmed' : 'relative'} onChange={(e) => edit(key, e.target.value === 'confirmed' ? { anchor: 'confirmed' } : { anchor: 'check_in' })}>
                <option value="confirmed">when a booking is confirmed</option>
                <option value="relative">at a set time around the stay</option>
              </select>
              {r.anchor !== 'confirmed' && (
                <>
                  {dir !== 'on' && <input type="number" min="1" max="365" className="msg-num" value={n} onChange={(e) => setOffset(dir, Number(e.target.value))} />}
                  <select value={dir} onChange={(e) => setOffset(e.target.value, n)}>
                    <option value="before">day(s) before</option>
                    <option value="on">on the day of</option>
                    <option value="after">day(s) after</option>
                  </select>
                  <select value={r.anchor} onChange={(e) => edit(key, { anchor: e.target.value })}>
                    <option value="check_in">check-in</option>
                    <option value="check_out">check-out</option>
                  </select>
                  <span>at</span>
                  <input type="time" value={r.sendTime} onChange={(e) => edit(key, { sendTime: e.target.value })} />
                </>
              )}
            </div>

            <div className="sp-units">
              <span className="sp-units-label">Properties:</span>
              <button type="button" className={`sp-unit${r.propertyIds.length === 0 ? ' on' : ''}`} onClick={() => edit(key, { propertyIds: [] })}>All</button>
              {properties.map((p) => {
                const on = r.propertyIds.includes(p.id);
                return <button key={p.id} type="button" className={`sp-unit${on ? ' on' : ''}`}
                  onClick={() => edit(key, { propertyIds: on ? r.propertyIds.filter((x) => x !== p.id) : [...r.propertyIds, p.id] })}>{p.name}</button>;
              })}
            </div>

            <div className="msg-sched-row">
              <span className="msg-lbl">Message</span>
              <select value={r.templateId} onChange={(e) => edit(key, { templateId: e.target.value })}>
                <option value="">✍ Type a custom message</option>
                {templates.map((t) => <option key={t.id} value={t.id}>📝 {t.name}</option>)}
              </select>
            </div>
            {r.templateId
              ? <p className="msg-preview small">{(templates.find((t) => t.id === r.templateId) || {}).body}</p>
              : <textarea className="msg-tpl-body" rows={4} placeholder="Hi {firstName}, …" value={r.body} onChange={(e) => edit(key, { body: e.target.value })} />}

            <div className="msg-send-row">
              <span className="muted small">{describe(r, properties)}{r.id ? ` · sent ${r.sentCount}×` : ''}</span>
              <span>
                <button className="secondary" onClick={() => remove(r, key)}>{r.id ? 'Delete' : 'Discard'}</button>{' '}
                <button disabled={!r.dirty} onClick={() => save(r)}>{r.id ? 'Save' : 'Create'}</button>
              </span>
            </div>
          </section>
        );
      })}
    </div>
  );
}
