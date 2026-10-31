import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Teach Simon — the host side of the "Ask Simon" AI on the shopfront.
//   Waiting      — questions Simon couldn't answer; your answer is saved, sent to the guest,
//                  and Simon re-tries the other waiting questions with what it just learned
//   Answered     — what Simon told guests; correct anything it got wrong
//   What Simon knows — every saved answer, per property or for all properties
export default function TeachSimon({ properties = [], onCountChange }) {
  const [view, setView] = useState('waiting');
  const [status, setStatus] = useState(null);
  const [count, setCount] = useState(0);

  const refreshCount = () => api.teachCount().then((r) => { setCount(r.count); onCountChange && onCountChange(); }).catch(() => {});
  useEffect(() => { api.teachStatus().then(setStatus).catch(() => {}); refreshCount(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="gb-wrap">
      <p className="muted small">
        Guests ask <b>Simon</b> questions on each stay’s page. Simon answers from your listing details and everything you teach it here.
        When it doesn’t know, the question waits here for you — answer once, and Simon knows it from then on.
      </p>
      {status && !status.enabled && (
        <div className="msg-warn" style={{ margin: '0 0 12px' }}>Simon is switched off on this server (no ANTHROPIC_API_KEY), so every question comes straight to you.</div>
      )}
      <div className="msg-tabs sub">
        <button className={view === 'waiting' ? 'on' : ''} onClick={() => setView('waiting')}>❓ Waiting{count ? ` (${count})` : ''}</button>
        <button className={view === 'answered' ? 'on' : ''} onClick={() => setView('answered')}>✅ Answered by Simon</button>
        <button className={view === 'knowledge' ? 'on' : ''} onClick={() => setView('knowledge')}>🧠 What Simon knows</button>
      </div>
      {view === 'knowledge'
        ? <Knowledge properties={properties} />
        : <Questions key={view} status={view === 'waiting' ? 'needs_answer' : 'answered'} onChanged={refreshCount} />}
    </div>
  );
}

function fmtWhen(d) { return new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }

function Questions({ status, onChanged }) {
  const [rows, setRows] = useState(null);
  const [drafts, setDrafts] = useState({}); // id -> { answer, scope, open }
  const [msg, setMsg] = useState('');
  const waiting = status === 'needs_answer';

  const load = () => api.teachQuestions(status).then((r) => setRows(r.questions)).catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
    // Simon re-tries waiting questions in the background after you teach it — pick those up.
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [status]);
  const setDraft = (id, patch) => setDrafts((d) => ({ ...d, [id]: { scope: 'property', answer: '', ...d[id], ...patch } }));

  async function teach(q) {
    const d = drafts[q.id] || {};
    if (!(d.answer || '').trim()) return;
    try {
      const r = await api.teachAnswer(q.id, { answer: d.answer, scope: d.scope || 'property' });
      setMsg(r.delivered ? 'Saved — Simon knows this now, and the guest has been messaged.' : 'Saved — Simon knows this now. The guest will see it next time they open Ask Simon.');
      setDrafts((x) => ({ ...x, [q.id]: undefined }));
      await load(); onChanged();
    } catch (e) { setMsg((e.data && e.data.message) || e.message); }
  }
  async function dismiss(q) {
    try { await api.teachDismiss(q.id); await load(); onChanged(); } catch (e) { setMsg(e.message); }
  }

  if (!rows) return <p className="muted small">Loading…</p>;
  return (
    <>
      {msg && <p className="small"><b>{msg}</b></p>}
      {rows.length === 0 && <p className="muted small">{waiting ? 'Nothing waiting — Simon has answered everything so far. 🎉' : 'Simon hasn’t answered any questions yet.'}</p>}
      {rows.map((q) => {
        const d = drafts[q.id] || {};
        const open = waiting || d.open;
        return (
          <section key={q.id} className="sp-card">
            <div className="muted small">{q.propertyName} · {fmtWhen(q.createdAt)}{q.guest ? ` · ${q.guest}` : ' · visitor'}</div>
            <div className="teach-q">“{q.question}”</div>
            {!waiting && <div className="msg-preview small"><b>Simon:</b> {q.answer}</div>}
            {open ? (
              <>
                <textarea className="msg-tpl-body" rows={3} autoFocus={!waiting}
                  placeholder={waiting ? 'Your answer — Simon will use it for every guest from now on' : 'The correct answer'}
                  value={d.answer || ''} onChange={(e) => setDraft(q.id, { answer: e.target.value })} />
                <div className="msg-send-row">
                  <select value={d.scope || 'property'} onChange={(e) => setDraft(q.id, { scope: e.target.value })}>
                    <option value="property">Applies to {q.propertyName}</option>
                    <option value="all">Applies to all my properties</option>
                  </select>
                  <span>
                    {waiting
                      ? <button className="secondary" onClick={() => dismiss(q)} title="Spam or not worth answering">Dismiss</button>
                      : <button className="secondary" onClick={() => setDraft(q.id, { open: false })}>Cancel</button>}{' '}
                    <button disabled={!(d.answer || '').trim()} onClick={() => teach(q)}>🧠 Teach Simon</button>
                  </span>
                </div>
                {q.hasBooking && <p className="muted small">This guest has a booking — your answer is also sent to their messages.</p>}
              </>
            ) : (
              <button className="mini" onClick={() => setDraft(q.id, { open: true })}>✏️ Correct this answer</button>
            )}
          </section>
        );
      })}
    </>
  );
}

function Knowledge({ properties }) {
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('');
  const [nw, setNw] = useState({ question: '', answer: '', propertyId: '' });
  const [msg, setMsg] = useState('');
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1600); };

  const load = () => api.listKnowledge().then((r) => setRows(r.entries)).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  const edit = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch, dirty: true } : r)));

  async function add() {
    if (!nw.question.trim() || !nw.answer.trim()) { setMsg('Add both a question and an answer.'); return; }
    try { await api.createKnowledge({ ...nw, propertyId: nw.propertyId || null }); setNw({ question: '', answer: '', propertyId: nw.propertyId }); await load(); flash('Saved.'); }
    catch (e) { setMsg((e.data && e.data.message) || e.message); }
  }
  async function save(r) {
    if (!r.dirty) return;
    try { await api.updateKnowledge(r.id, { question: r.question, answer: r.answer, propertyId: r.propertyId || null }); await load(); flash('Saved.'); }
    catch (e) { setMsg((e.data && e.data.message) || e.message); }
  }
  async function remove(r) {
    if (!window.confirm('Delete this answer? Simon will stop using it.')) return;
    try { await api.deleteKnowledge(r.id); await load(); } catch (e) { setMsg(e.message); }
  }

  const PropSelect = ({ value, onChange }) => (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">All my properties</option>
      {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
  const shown = (rows || []).filter((r) => !filter || (filter === 'all' ? !r.propertyId : r.propertyId === filter));

  return (
    <>
      <p className="muted small">Simon also reads your listing details (descriptions, check-in times, parking, backup power, policies) — add here anything guests ask that those don’t cover. {msg && <b>{msg}</b>}</p>
      <section className="sp-card">
        <input className="sp-name" placeholder="Question, e.g. Is there a pool?" value={nw.question} onChange={(e) => setNw({ ...nw, question: e.target.value })} />
        <textarea className="msg-tpl-body" rows={3} placeholder="Answer, e.g. Yes — a heated rooftop pool, open 7am–9pm." value={nw.answer} onChange={(e) => setNw({ ...nw, answer: e.target.value })} />
        <div className="msg-send-row">
          <PropSelect value={nw.propertyId} onChange={(v) => setNw({ ...nw, propertyId: v })} />
          <button onClick={add}>➕ Teach Simon</button>
        </div>
      </section>

      {rows && rows.length > 0 && (
        <div className="msg-sched-row" style={{ marginBottom: 10 }}>
          <span className="msg-lbl">Show</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Everything ({rows.length})</option>
            <option value="all">For all properties</option>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {!rows ? <p className="muted small">Loading…</p> : shown.length === 0 ? <p className="muted small">Nothing here yet.</p> : shown.map((r) => (
        <section key={r.id} className="sp-card">
          <div className="sp-top">
            <input className="sp-name" value={r.question} onChange={(e) => edit(r.id, { question: e.target.value })} onBlur={() => save(r)} />
            <button className="del" title="Delete" onClick={() => remove(r)}>🗑</button>
          </div>
          <textarea className="msg-tpl-body" rows={2} value={r.answer} onChange={(e) => edit(r.id, { answer: e.target.value })} onBlur={() => save(r)} />
          <PropSelect value={r.propertyId} onChange={(v) => { const next = { ...r, propertyId: v || null, dirty: true }; edit(r.id, { propertyId: v || null }); save(next); }} />
        </section>
      ))}
    </>
  );
}
