import { useEffect, useState } from 'react';
import { api, photoUrl } from '../api.js';

// Evidence for a reduced deposit refund: tap photos from the unit's reports
// around checkout, and add invoices (PDF or photo). The guest sees them on
// their refund link.
const fmtDT = (d) => new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const TYPE = { clean: 'Checkout clean', damage: 'Damage report', repair: 'Repair' };

// A phone photo of an invoice can be 5 MB: shrink images before upload. PDFs go as they are.
function readFile(file) {
  return new Promise((resolve, reject) => {
    const asData = () => { const fr = new FileReader(); fr.onload = () => resolve({ filename: file.name, contentType: file.type, dataBase64: fr.result }); fr.onerror = reject; fr.readAsDataURL(file); };
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return asData();
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ filename: file.name.replace(/\.\w+$/, '') + '.jpg', contentType: 'image/jpeg', dataBase64: c.toDataURL('image/jpeg', 0.85) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); asData(); };
    img.src = url;
  });
}

// The picker. `value` = { photoIds: [], files: [{ filename, contentType, dataBase64 }] }.
export function EvidencePicker({ bookingId, value, onChange, skip = [] }) {
  const [opts, setOpts] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.adminRefundEvidence(bookingId).then(setOpts).catch((e) => setErr((e.data && e.data.message) || e.message));
  }, [bookingId]);
  const picked = new Set(value.photoIds);
  const toggle = (id) => onChange({ ...value, photoIds: picked.has(id) ? value.photoIds.filter((p) => p !== id) : [...value.photoIds, id] });
  async function addFiles(list) {
    setErr('');
    try {
      const read = await Promise.all([...list].map(readFile));
      const big = read.find((f) => f.dataBase64.length > 8 * 1024 * 1024);
      if (big) { setErr(`${big.filename} is too big (over 6 MB).`); return; }
      onChange({ ...value, files: [...value.files, ...read] });
    } catch { setErr('Could not read that file.'); }
  }
  const reports = opts ? opts.reports.map((r) => ({ ...r, photos: r.photos.filter((p) => !skip.includes(p.id)) })).filter((r) => r.photos.length) : [];
  return (
    <div className="rev">
      <div className="small"><b>Evidence for the guest</b> <span className="muted">(optional): tap report photos to attach them, and add invoices.</span></div>
      {!opts && !err && <div className="muted small">Loading reports…</div>}
      {opts && !reports.length && <div className="muted small">No report photos for this unit from the day before checkout{opts.checkOut ? ` (${opts.checkOut})` : ''} to a week after.</div>}
      {reports.map((r) => (
        <div key={r.id} className="rev-rep">
          <div className="muted small">{TYPE[r.type] || r.type} · {fmtDT(r.createdAt)}{r.submitterName ? ` · ${r.submitterName}` : ''}</div>
          <div className="rev-grid">
            {r.photos.map((p) => (
              <button type="button" key={p.id} className={`rev-ph${picked.has(p.id) ? ' on' : ''}`} onClick={() => toggle(p.id)} title={picked.has(p.id) ? 'Attached: tap to remove' : 'Tap to attach'}>
                <img src={`${photoUrl(p.id)}?w=320`} alt="" loading="lazy" />
                {picked.has(p.id) && <span className="rev-tick">✓</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="rev-files">
        {value.files.map((f, i) => (
          <span key={i} className="rev-file">{f.contentType === 'application/pdf' ? '📄' : '🧾'} {f.filename}
            <button type="button" className="linklike" onClick={() => onChange({ ...value, files: value.files.filter((_, j) => j !== i) })} aria-label={`Remove ${f.filename}`}>✕</button>
          </span>
        ))}
        <label className="mini rev-add">＋ Add invoice<input type="file" accept="application/pdf,image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} /></label>
      </div>
      {(value.photoIds.length > 0 || value.files.length > 0) && <div className="muted small">{value.photoIds.length} photo{value.photoIds.length === 1 ? '' : 's'} and {value.files.length} invoice{value.files.length === 1 ? '' : 's'} attached.</div>}
      {err && <div className="msg-warn">{err}</div>}
    </div>
  );
}

// What's attached to a refund already, with remove (before it's agreed) and
// "add more".
export function RefundEvidence({ x, onDone }) {
  const r = x.refund;
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState({ photoIds: [], files: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const open = ['started', 'guest', 'disputed'].includes(r.status);
  const photos = r.photoIds || [];
  const files = r.files || [];
  async function call(fn, after) {
    setBusy(true); setErr('');
    try { const out = await fn(); if (out && out.message) window.alert(out.message); after && after(); onDone(); }
    catch (e) { setErr((e.data && e.data.message) || e.message); } finally { setBusy(false); }
  }
  if (!photos.length && !files.length && !open) return null;
  return (
    <div className="rev-have">
      {photos.length > 0 && (
        <div className="rev-grid">
          {photos.map((id) => (
            <span key={id} className="rev-ph on">
              <a href={photoUrl(id)} target="_blank" rel="noreferrer"><img src={`${photoUrl(id)}?w=320`} alt="" loading="lazy" /></a>
              {open && <button type="button" className="rev-x" disabled={busy} title="Remove" onClick={() => call(() => api.adminRemoveRefundEvidence(r.id, { photoId: id }))}>✕</button>}
            </span>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="rev-files">
          {files.map((f) => (
            <span key={f.id} className="rev-file">{f.contentType === 'application/pdf' ? '📄' : '🧾'} {x.guestLink ? <a href={`${x.guestLink.replace('/deposit/', '/public/deposit/')}/file/${f.id}`} target="_blank" rel="noreferrer">{f.filename}</a> : f.filename}
              {open && <button type="button" className="linklike" disabled={busy} aria-label={`Remove ${f.filename}`} onClick={() => call(() => api.adminRemoveRefundEvidence(r.id, { fileId: f.id }))}>✕</button>}
            </span>
          ))}
        </div>
      )}
      {open && !adding && <button type="button" className="linklike small" onClick={() => setAdding(true)}>＋ Attach photos or invoices</button>}
      {open && adding && (
        <>
          <EvidencePicker bookingId={x.bookingId} value={val} onChange={setVal} skip={photos} />
          <button className="mini" disabled={busy || (!val.photoIds.length && !val.files.length)} onClick={() => call(() => api.adminAddRefundEvidence(r.id, val), () => { setAdding(false); setVal({ photoIds: [], files: [] }); })}>Attach</button>
          <button className="mini" onClick={() => { setAdding(false); setVal({ photoIds: [], files: [] }); }}>Cancel</button>
        </>
      )}
      {err && <div className="msg-warn">{err}</div>}
    </div>
  );
}
