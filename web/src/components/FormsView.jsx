import { useEffect, useMemo, useState } from 'react';
import { api, photoUrl } from '../api.js';

const FIELD_TYPES = [
  ['text', 'Short text'], ['textarea', 'Long text'], ['number', 'Number'], ['money', 'Money (R)'],
  ['select', 'Choice list'], ['checkbox', 'Yes / no'], ['date', 'Date'], ['rating', 'Rating (1–5)'], ['photos', 'Photo upload'],
];
const genId = () => 'f_' + Math.random().toString(36).slice(2, 9);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');

export default function FormsView({ onClose, properties = [] }) {
  const [tab, setTab] = useState('submissions'); // 'submissions' | 'design'
  const [templates, setTemplates] = useState(null);
  const [msg, setMsg] = useState('');
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1600); };

  async function loadTemplates() { const r = await api.listFormTemplates(); setTemplates(r.templates); }
  useEffect(() => { loadTemplates(); }, []);

  // fieldId → label, across both templates, for rendering answers
  const labelById = useMemo(() => {
    const m = {};
    (templates || []).forEach((t) => (t.fields || []).forEach((f) => { m[f.id] = f.label; }));
    return m;
  }, [templates]);

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Forms</span>
        <div className="forms-tabs">
          <button className={tab === 'submissions' ? 'active' : ''} onClick={() => setTab('submissions')}>📥 Submissions</button>
          <button className={tab === 'design' ? 'active' : ''} onClick={() => setTab('design')}>🛠 Design forms</button>
        </div>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      <div className="forms-wrap">
        {tab === 'submissions'
          ? <Submissions properties={properties} labelById={labelById} />
          : <Design templates={templates} onReload={loadTemplates} flash={flash} />}
      </div>
    </div>
  );
}

/* ---------------- Submissions: search + review ---------------- */
function Submissions({ properties, labelById }) {
  const [type, setType] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(null); // full submission

  async function load() {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (propertyId) params.set('propertyId', propertyId);
    if (status) params.set('status', status);
    if (q.trim()) params.set('q', q.trim());
    const s = params.toString();
    const r = await api.listFormSubmissions(s ? `?${s}` : '');
    setRows(r.submissions);
  }
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [type, propertyId, status, q]);

  async function open(id) { const r = await api.getFormSubmission(id); setSel(r.submission); }
  async function setStatusOf(id, s) { await api.updateFormSubmission(id, { status: s }); setSel((x) => (x && x.id === id ? { ...x, status: s } : x)); load(); }
  async function del(id) { if (!window.confirm('Delete this submission?')) return; await api.deleteFormSubmission(id); setSel(null); load(); }

  return (
    <div className="forms-cols">
      <aside className="forms-list">
        <div className="forms-filters">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All forms</option>
            <option value="damage">Damage / issue</option>
            <option value="clean">Checkout clean</option>
          </select>
          <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            <option value="">All properties</option>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="new">New</option>
            <option value="reviewed">Reviewed</option>
            <option value="resolved">Resolved</option>
          </select>
          <input type="search" placeholder="Search name / contact…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!rows ? <p className="muted small">Loading…</p> : rows.length === 0 ? (
          <p className="muted small">No submissions yet{type || propertyId || status || q ? ' match this filter' : ''}.</p>
        ) : rows.map((r) => (
          <button key={r.id} className={`forms-item ${sel?.id === r.id ? 'active' : ''}`} onClick={() => open(r.id)}>
            <div className="fi-top">
              <span className={`ftag ${r.type}`}>{r.type === 'damage' ? 'Issue' : 'Clean'}</span>
              <span className={`fstatus ${r.status}`}>{r.status}</span>
            </div>
            <div className="fi-mid">{r.propertyName ? `${r.propertyName}${r.unitName ? ' · ' + r.unitName : ''}` : 'No property'}</div>
            <div className="fi-sub">{r.submitterName || '—'} · {fmtDate(r.createdAt)}{r.photoCount ? ` · 📷 ${r.photoCount}` : ''}</div>
          </button>
        ))}
      </aside>

      <main className="forms-detail">
        {!sel ? <div className="center muted">Select a submission to view it.</div> : (
          <div className="sub-card">
            <div className="sub-head">
              <div>
                <span className={`ftag ${sel.type}`}>{sel.type === 'damage' ? 'Damage / issue' : 'Checkout clean'}</span>
                <h3>{sel.propertyName ? `${sel.propertyName}${sel.unitName ? ' · ' + sel.unitName : ''}` : 'No property'}</h3>
                <p className="muted small">{sel.submitterName || 'Anonymous'}{sel.submitterContact ? ` · ${sel.submitterContact}` : ''} · {fmtDate(sel.createdAt)}</p>
              </div>
              <div className="sub-actions">
                {['new', 'reviewed', 'resolved'].map((s) => (
                  <button key={s} className={`chip ${sel.status === s ? 'on' : ''}`} onClick={() => setStatusOf(sel.id, s)}>{s}</button>
                ))}
                <button className="del" title="Delete" onClick={() => del(sel.id)}>🗑</button>
              </div>
            </div>

            <div className="sub-answers">
              {Object.keys(sel.answers || {}).length === 0 && <p className="muted small">No text answers.</p>}
              {Object.entries(sel.answers || {}).map(([fid, val]) => (
                <div key={fid} className="ans-row">
                  <div className="ans-label">{labelById[fid] || fid}</div>
                  <div className="ans-val">{formatAnswer(val)}</div>
                </div>
              ))}
            </div>

            {sel.photos && sel.photos.length > 0 && (
              <div className="sub-photos">
                <div className="ans-label">Photos ({sel.photos.length})</div>
                <div className="sub-photo-grid">
                  {sel.photos.map((ph) => (
                    <a key={ph.id} href={photoUrl(ph.id)} target="_blank" rel="noreferrer" title={ph.filename || 'photo'}>
                      <img src={photoUrl(ph.id)} alt={ph.filename || 'photo'} loading="lazy" />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function formatAnswer(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (Array.isArray(v)) return v.join(', ');
  return String(v ?? '');
}

/* ---------------- Design: the form builder ---------------- */
function Design({ templates, onReload, flash }) {
  if (!templates) return <p className="muted small">Loading…</p>;
  return (
    <div className="design-wrap">
      {templates.map((t) => <FormBuilder key={t.type} initial={t} onReload={onReload} flash={flash} />)}
    </div>
  );
}

function FormBuilder({ initial, onReload, flash }) {
  const [title, setTitle] = useState(initial.title || '');
  const [description, setDescription] = useState(initial.description || '');
  const [fields, setFields] = useState(initial.fields || []);
  const [busy, setBusy] = useState(false);

  const setField = (i, patch) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i, d) => setFields((fs) => { const j = i + d; if (j < 0 || j >= fs.length) return fs; const c = [...fs]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  const remove = (i) => setFields((fs) => fs.filter((_, j) => j !== i));
  const add = () => setFields((fs) => [...fs, { id: genId(), label: '', type: 'text', required: false }]);

  async function save() {
    setBusy(true);
    try {
      await api.saveFormTemplate(initial.type, { title, description, fields, active: true });
      flash('Saved.'); onReload();
    } catch (e) { flash(e.message); } finally { setBusy(false); }
  }

  return (
    <section className="builder-card">
      <div className="builder-head">
        <span className={`ftag ${initial.type}`}>{initial.type === 'damage' ? 'Damage / issue (guests)' : 'Checkout clean (cleaners)'}</span>
        <button className="ghost save" disabled={busy} onClick={save}>{busy ? 'Saving…' : '💾 Save form'}</button>
      </div>
      <label className="bl">Form title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="bl">Intro text<textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>

      <div className="builder-fields">
        {fields.length === 0 && <p className="muted small">No questions yet — add one below.</p>}
        {fields.map((f, i) => (
          <div key={f.id} className="bfield">
            <div className="bfield-row">
              <input className="bfield-label" placeholder="Question label" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
              <select value={f.type} onChange={(e) => setField(i, { type: e.target.value })}>
                {FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <label className="req"><input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required</label>
              <span className="bfield-move">
                <button className="del" title="Up" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
                <button className="del" title="Down" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>▼</button>
                <button className="del" title="Remove" onClick={() => remove(i)}>×</button>
              </span>
            </div>
            {f.type === 'select' && (
              <input className="bfield-opts" placeholder="Choices, comma-separated (e.g. Minor, Moderate, Urgent)"
                value={(f.options || []).join(', ')}
                onChange={(e) => setField(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            )}
          </div>
        ))}
        <button className="mini" onClick={add}>+ Add question</button>
      </div>
    </section>
  );
}
