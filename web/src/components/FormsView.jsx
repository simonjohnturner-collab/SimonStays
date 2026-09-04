import { useEffect, useMemo, useState } from 'react';
import { api, photoUrl, formLink } from '../api.js';

// Bar with the public, shareable links guests/cleaners use to FILL IN a form.
function FormLinks() {
  const [copied, setCopied] = useState('');
  function copy(type) {
    const url = formLink(type);
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .catch(() => { const t = document.createElement('textarea'); t.value = url; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); });
    setCopied(type); setTimeout(() => setCopied(''), 1500);
  }
  return (
    <div className="forms-links">
      <span className="fl-label">Send these links to fill in a form:</span>
      <span className="fl-group">
        <a className="fl-btn damage" href={formLink('damage')} target="_blank" rel="noreferrer">⚠️ Damage report ↗</a>
        <button className="fl-copy" onClick={() => copy('damage')}>{copied === 'damage' ? 'Copied ✓' : 'Copy link'}</button>
      </span>
      <span className="fl-group">
        <a className="fl-btn clean" href={formLink('clean')} target="_blank" rel="noreferrer">🧹 Cleaner report ↗</a>
        <button className="fl-copy" onClick={() => copy('clean')}>{copied === 'clean' ? 'Copied ✓' : 'Copy link'}</button>
      </span>
    </div>
  );
}

const FIELD_TYPES = [
  ['text', 'Short text'], ['textarea', 'Long text'], ['number', 'Number'], ['money', 'Money (R)'],
  ['select', 'Choice list'], ['checkbox', 'Yes / no'], ['date', 'Date'], ['rating', 'Rating (1–5)'], ['photos', 'Photo upload'],
];
const genId = () => 'f_' + Math.random().toString(36).slice(2, 9);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');

export default function FormsView({ onClose, properties = [], initialSubmissionId = null }) {
  const [tab, setTab] = useState('submissions'); // 'submissions' | 'design'
  const [forms, setForms] = useState(null); // { damage, cleanForms:[...] }
  const [msg, setMsg] = useState('');
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1600); };

  async function loadForms() { const r = await api.listFormTemplates(); setForms(r); }
  useEffect(() => { loadForms(); }, []);

  // fieldId → label, across every form, for rendering answers
  const labelById = useMemo(() => {
    const m = {};
    if (forms) {
      (forms.damage?.fields || []).forEach((f) => { m[f.id] = f.label; });
      (forms.cleanForms || []).forEach((t) => (t.fields || []).forEach((f) => { m[f.id] = f.label; }));
    }
    return m;
  }, [forms]);

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

      <FormLinks />

      <div className="forms-wrap">
        {tab === 'submissions'
          ? <Submissions properties={properties} labelById={labelById} initialSubmissionId={initialSubmissionId} />
          : <Design forms={forms} properties={properties} onReload={loadForms} flash={flash} />}
      </div>
    </div>
  );
}

/* ---------------- Submissions: search + review ---------------- */
function Submissions({ properties, labelById, initialSubmissionId }) {
  const [type, setType] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(null); // full submission
  const [zoom, setZoom] = useState(null); // photo url open in the lightbox

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

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
  useEffect(() => { if (initialSubmissionId) open(initialSubmissionId); /* eslint-disable-next-line */ }, [initialSubmissionId]);

  async function open(id) { const r = await api.getFormSubmission(id); setSel(r.submission); }
  async function setStatusOf(id, s) { await api.updateFormSubmission(id, { status: s }); setSel((x) => (x && x.id === id ? { ...x, status: s } : x)); load(); }
  async function del(id) { if (!window.confirm('Delete this submission?')) return; await api.deleteFormSubmission(id); setSel(null); load(); }

  return (
    <>
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

            {(() => {
              const answers = sel.answers || {};
              const issues = Array.isArray(answers.issues) ? answers.issues : null;
              const known = { date: 'Date' };
              const other = Object.entries(answers).filter(([k]) => k !== 'issues');
              const byField = {};
              (sel.photos || []).forEach((ph) => { const k = ph.fieldId || ''; (byField[k] = byField[k] || []).push(ph); });
              const usedFields = new Set(issues ? issues.map((_, i) => `issue-${i}`) : []);
              const leftover = (sel.photos || []).filter((ph) => !usedFields.has(ph.fieldId || ''));
              const Gallery = ({ photos }) => (
                <div className="sub-photo-grid">
                  {photos.map((ph) => (
                    <button key={ph.id} type="button" className="thumb-btn" title={ph.filename || 'photo'} onClick={() => setZoom(photoUrl(ph.id))}>
                      <img src={photoUrl(ph.id)} alt={ph.filename || 'photo'} loading="lazy" />
                    </button>
                  ))}
                </div>
              );
              return (
                <>
                  <div className="sub-answers">
                    {other.length === 0 && !issues && <p className="muted small">No answers.</p>}
                    {other.map(([fid, val]) => (
                      <div key={fid} className="ans-row">
                        <div className="ans-label">{known[fid] || labelFor(fid, labelById)}</div>
                        <div className="ans-val">{formatAnswer(val)}</div>
                      </div>
                    ))}
                  </div>

                  {issues && (
                    <div className="sub-issues">
                      {issues.map((iss, i) => (
                        <div key={i} className="issue-block">
                          <div className="ans-label">Issue {i + 1}</div>
                          <div className="ans-val">{iss.description || ''}</div>
                          {byField[`issue-${i}`] && <Gallery photos={byField[`issue-${i}`]} />}
                        </div>
                      ))}
                    </div>
                  )}

                  {leftover.length > 0 && (() => {
                    const groups = {};
                    leftover.forEach((ph) => { const k = ph.fieldId || ''; (groups[k] = groups[k] || []).push(ph); });
                    return Object.entries(groups).map(([fid, photos]) => (
                      <div className="sub-photos" key={fid || 'photos'}>
                        <div className="ans-label">{fid ? labelFor(fid, labelById) : 'Photos'} ({photos.length})</div>
                        <Gallery photos={photos} />
                      </div>
                    ));
                  })()}
                </>
              );
            })()}
          </div>
        )}
      </main>
    </div>
    {zoom && (
      <div className="img-lightbox" onClick={() => setZoom(null)}>
        <button className="img-lightbox-close" onClick={() => setZoom(null)} aria-label="Close image">×</button>
        <img src={zoom} alt="" onClick={(e) => e.stopPropagation()} />
      </div>
    )}
    </>
  );
}

function formatAnswer(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (Array.isArray(v)) return v.join(', ');
  return String(v ?? '');
}

// Field labels for answers/photos, resolving repeated per-room ids ("id__2").
function labelFor(fid, labelById = {}) {
  const parts = String(fid).split('__');
  const base = parts[0], idx = parts[1];
  const lbl = labelById[fid] || labelById[base] || base;
  return idx ? `${lbl} · #${idx}` : lbl;
}

/* ---------------- Design: the form builder ---------------- */
function Design({ forms, properties, onReload, flash }) {
  const [creating, setCreating] = useState(false);
  if (!forms) return <p className="muted small">Loading…</p>;
  async function addClean() {
    setCreating(true);
    try { await api.createCleanForm({ name: 'New clean form', unitIds: [], title: 'Checkout clean report', fields: [] }); onReload(); }
    finally { setCreating(false); }
  }
  return (
    <div className="design-wrap">
      <FormBuilder kind="damage" initial={forms.damage} properties={properties} onReload={onReload} flash={flash} />
      <div className="clean-forms-head">Checkout clean forms <span className="muted small">— the cleaner gets the one matching the unit they pick</span></div>
      {(forms.cleanForms || []).map((t) => (
        <FormBuilder key={t.id} kind="clean" initial={t} properties={properties} onReload={onReload} flash={flash} />
      ))}
      <button className="wide secondary" disabled={creating} onClick={addClean}>＋ Add another clean form</button>
    </div>
  );
}

function FormBuilder({ kind, initial, properties, onReload, flash }) {
  const [name, setName] = useState(initial.name || '');
  const [title, setTitle] = useState(initial.title || '');
  const [description, setDescription] = useState(initial.description || '');
  const [fields, setFields] = useState(initial.fields || []);
  const [unitIds, setUnitIds] = useState(Array.isArray(initial.unitIds) ? initial.unitIds : []);
  const [busy, setBusy] = useState(false);
  const isClean = kind === 'clean';

  const setField = (i, patch) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i, d) => setFields((fs) => { const j = i + d; if (j < 0 || j >= fs.length) return fs; const c = [...fs]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  const remove = (i) => setFields((fs) => fs.filter((_, j) => j !== i));
  const add = () => setFields((fs) => [...fs, { id: genId(), label: '', type: 'text', required: false }]);
  const toggleUnit = (id) => setUnitIds((u) => (u.includes(id) ? u.filter((x) => x !== id) : [...u, id]));

  async function save() {
    setBusy(true);
    try {
      if (!isClean) await api.saveDamageForm({ title, description, fields });
      else if (initial.id) await api.updateCleanForm(initial.id, { name, unitIds, title, description, fields });
      else await api.createCleanForm({ name, unitIds, title, description, fields });
      flash('Saved.'); onReload();
    } catch (e) { flash(e.message); } finally { setBusy(false); }
  }
  async function del() {
    if (!window.confirm(`Delete the "${name}" clean form?`)) return;
    try { await api.deleteCleanForm(initial.id); onReload(); } catch (e) { flash(e.message); }
  }

  return (
    <section className="builder-card">
      <div className="builder-head">
        <span className={`ftag ${kind}`}>{isClean ? '🧹 Checkout clean' : '⚠️ Damage / issue (guests)'}</span>
        <span className="bh-actions">
          {isClean && initial.id && <button className="del" title="Delete this form" onClick={del}>🗑</button>}
          <button className="ghost save" disabled={busy} onClick={save}>{busy ? 'Saving…' : '💾 Save'}</button>
        </span>
      </div>

      {isClean && <label className="bl">Form name <span className="muted small">(for you)</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rosebank" /></label>}
      <label className="bl">Title shown to the person<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="bl">Intro text<textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>

      {isClean && (
        <div className="assign-units">
          <div className="bl" style={{ margin: '8px 0 4px' }}>Applies to these units</div>
          <div className="unit-checks">
            {properties.map((p) => p.units.length > 0 && (
              <div key={p.id} className="uc-prop">
                <div className="uc-prop-name">{p.name}</div>
                {p.units.map((u) => (
                  <label key={u.id} className="uc"><input type="checkbox" checked={unitIds.includes(u.id)} onChange={() => toggleUnit(u.id)} /> {u.name}</label>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="builder-fields">
        {fields.length === 0 && <p className="muted small">No questions yet — add one below.</p>}
        {fields.map((f, i) => (
          <div key={f.id} className="bfield">
            <div className="bfield-row">
              <input className="bfield-label" placeholder="Question label" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
              <select value={f.type} onChange={(e) => setField(i, { type: e.target.value })}>
                {FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <label className="req"><input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Req</label>
              <span className="bfield-move">
                <button className="del" title="Up" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
                <button className="del" title="Down" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>▼</button>
                <button className="del" title="Remove" onClick={() => remove(i)}>×</button>
              </span>
            </div>
            {f.type === 'select' && (
              <input className="bfield-opts" placeholder="Choices, comma-separated (e.g. EFT, eWallet)"
                value={(f.options || []).join(', ')}
                onChange={(e) => setField(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            )}
            {isClean && (
              <label className="bfield-repeat">Ask
                <select value={f.repeat || ''} onChange={(e) => setField(i, { repeat: e.target.value || undefined })}>
                  <option value="">once</option>
                  <option value="bedroom">per bedroom</option>
                  <option value="bathroom">per bathroom</option>
                </select>
              </label>
            )}
          </div>
        ))}
        <button className="mini" onClick={add}>+ Add question</button>
      </div>
    </section>
  );
}
