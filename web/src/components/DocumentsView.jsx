import { useEffect, useState } from 'react';
import { api } from '../api.js';

const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`Couldn’t read ${file.name}.`));
    r.readAsDataURL(file);
  });
}

// One property's shared folder: its link for guests, and the files in it.
function Folder({ folder, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1800); };

  function copy() {
    (navigator.clipboard ? navigator.clipboard.writeText(folder.link) : Promise.reject())
      .then(() => flash('Link copied.'))
      .catch(() => setMsg(folder.link));
  }
  async function upload(e) {
    const files = [...e.target.files];
    e.target.value = '';
    setBusy(true); setMsg('');
    try {
      for (const file of files) {
        await api.uploadDocument({ propertyId: folder.propertyId, filename: file.name, dataBase64: await readAsDataUrl(file) });
      }
      flash(files.length === 1 ? 'Uploaded.' : `${files.length} files uploaded.`);
    } catch (err) { setMsg((err.data && err.data.message) || err.message); }
    setBusy(false);
    onChanged();
  }
  async function remove(d) {
    if (!window.confirm(`Delete “${d.name}”? Guests won’t be able to download it any more.`)) return;
    try { await api.deleteDocument(d.id); onChanged(); } catch (err) { setMsg(err.message); }
  }

  return (
    <section className="sp-card doc-folder">
      <div className="sp-top">
        <b className="doc-folder-name">📁 {folder.name}</b>
        <button type="button" className="secondary small" onClick={copy}>Copy link for guests</button>
        <a className="secondary-link small" href={folder.link} target="_blank" rel="noreferrer">Open ↗</a>
        <label className={`doc-upload${busy ? ' busy' : ''}`}>
          {busy ? 'Uploading…' : '＋ Upload'}
          <input type="file" multiple hidden disabled={busy} aria-label={`Upload to ${folder.name}`} accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png" onChange={upload} />
        </label>
      </div>
      {msg && <div className="muted small doc-msg">{msg}</div>}
      {folder.documents.length === 0
        ? <p className="muted small">No files yet.</p>
        : folder.documents.map((d) => (
          <div key={d.id} className="doc-row">
            <span className="doc-row-name">{d.name}</span>
            <span className="muted small">{fmtSize(d.sizeBytes)}</span>
            <button type="button" className="doc-del" title="Delete" aria-label={`Delete ${d.name}`} onClick={() => remove(d)}>🗑</button>
          </div>
        ))}
    </section>
  );
}

// Files guests can download, one folder per property. A scheduled message reaches
// the right folder with the [Documents Link] shortcut.
export default function DocumentsView({ onClose }) {
  const [folders, setFolders] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.listDocuments().then((r) => setFolders(r.folders)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  return (
    <div className="invoices-view">
      <header className="topbar">
        <span className="host">House documents</span>
        <div className="spacer" />
      </header>
      <div className="gb-wrap">
        <p className="muted small">
          Forms and files for your guests, such as an HOA form. Add <code>[Documents Link]</code> to a scheduled message and each guest
          gets the link to their own property’s folder. Anyone with a link can download its files, so don’t upload anything private.
        </p>
        {err && <p className="msg-warn">{err}</p>}
        {!folders && !err && <p className="muted small">Loading…</p>}
        {folders && folders.length === 0 && <p className="muted small">Add a property first, then its folder appears here.</p>}
        {folders && folders.map((f) => <Folder key={f.propertyId} folder={f} onChanged={load} />)}
      </div>
    </div>
  );
}
