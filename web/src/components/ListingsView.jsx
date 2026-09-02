import { useEffect, useState } from 'react';
import { api, photoUrl } from '../api.js';

// Downscale a picked image in the browser to a sensible max dimension and
// re-encode as JPEG, so we never upload a 5MB phone photo. Returns a data URL.
function fileToResizedDataUrl(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (Math.max(width, height) > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

function PhotoGrid({ photos, onAdd, onCover, onDelete, busy }) {
  return (
    <div className="photo-grid">
      {photos.map((p, i) => (
        <div key={p.id} className="photo-tile">
          <img src={photoUrl(p.id)} alt={p.filename || 'photo'} loading="lazy" />
          {i === 0 && <span className="cover-badge">Cover</span>}
          <div className="photo-actions">
            {i !== 0 && <button title="Make cover photo" onClick={() => onCover(p.id)}>★</button>}
            <button title="Delete photo" className="danger" onClick={() => onDelete(p.id)}>🗑</button>
          </div>
        </div>
      ))}
      <label className={`photo-add ${busy ? 'busy' : ''}`}>
        {busy ? 'Uploading…' : '＋ Add photos'}
        <input type="file" accept="image/*" multiple disabled={busy}
          onChange={(e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) onAdd(f); }} />
      </label>
    </div>
  );
}

export default function ListingsView({ onClose }) {
  const [properties, setProperties] = useState(null);
  const [selectedId, setSelectedId] = useState(null); // property shown in the detail pane
  const [msg, setMsg] = useState('');
  const [busyPhoto, setBusyPhoto] = useState(null); // id of the property/unit currently uploading

  async function load() {
    const r = await api.getListings();
    setProperties(r.properties);
    setSelectedId((cur) => (cur && r.properties.some((p) => p.id === cur) ? cur : r.properties[0]?.id || null));
  }
  useEffect(() => { load(); }, []);

  // ---- local edits (kept in state; saved on the Save button) ----
  const editProp = (pid, patch) => setProperties((ps) => ps.map((p) => (p.id === pid ? { ...p, ...patch } : p)));
  const editUnit = (pid, uid, patch) =>
    setProperties((ps) => ps.map((p) => (p.id !== pid ? p : { ...p, units: p.units.map((u) => (u.id === uid ? { ...u, ...patch } : u)) })));

  async function saveProp(p) {
    setMsg('');
    try { await api.saveProperty(p.id, { name: p.name, address: p.address || '', description: p.description || '' }); flash('Saved.'); }
    catch (e) { setMsg(e.message); }
  }
  async function saveUnit(u) {
    setMsg('');
    try { await api.saveUnit(u.id, { name: u.name, capacity: u.capacity, description: u.description || '' }); flash('Saved.'); }
    catch (e) { setMsg(e.message); }
  }
  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 1500); }

  // ---- photos ----
  function setPhotos(kind, pid, uid, updater) {
    setProperties((ps) => ps.map((p) => {
      if (kind === 'property') return p.id === pid ? { ...p, photos: updater(p.photos) } : p;
      if (p.id !== pid) return p;
      return { ...p, units: p.units.map((u) => (u.id === uid ? { ...u, photos: updater(u.photos) } : u)) };
    }));
  }

  async function addPhotos(kind, pid, uid, files) {
    const key = kind === 'property' ? pid : uid;
    setBusyPhoto(key); setMsg('');
    try {
      for (const file of files) {
        const dataBase64 = await fileToResizedDataUrl(file);
        const { photo } = kind === 'property'
          ? await api.addPropertyPhoto(pid, { dataBase64, contentType: 'image/jpeg', filename: file.name })
          : await api.addUnitPhoto(uid, { dataBase64, contentType: 'image/jpeg', filename: file.name });
        setPhotos(kind, pid, uid, (arr) => [...arr, photo]);
      }
    } catch (e) { setMsg('Upload failed: ' + e.message); }
    finally { setBusyPhoto(null); }
  }
  async function coverPhoto(kind, pid, uid, id) {
    const prop = properties.find((p) => p.id === pid);
    const arr = (kind === 'property' ? prop?.photos : prop?.units.find((u) => u.id === uid)?.photos) || [];
    const target = Math.min(...arr.map((x) => x.sort)) - 1; // float above the current lowest
    setPhotos(kind, pid, uid, (a) => a.map((x) => (x.id === id ? { ...x, sort: target } : x)).sort((x, y) => x.sort - y.sort));
    try { await api.setPhotoSort(id, target); } catch (e) { setMsg(e.message); }
  }
  async function deletePhoto(kind, pid, uid, id) {
    if (!window.confirm('Delete this photo?')) return;
    setPhotos(kind, pid, uid, (arr) => arr.filter((x) => x.id !== id));
    try { await api.deletePhoto(id); } catch (e) { setMsg(e.message); }
  }

  return (
    <div className="invoices-view">
      <header className="topbar">
        <button className="brand linklike" onClick={onClose} title="Back to the board">Simon<span>Stays</span></button>
        <span className="host">Listings — descriptions &amp; photos</span>
        <div className="spacer" />
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        <button className="ghost" onClick={onClose}>🏠 Home</button>
      </header>

      {!properties ? <p className="muted small" style={{ padding: 16 }}>Loading…</p> : properties.length === 0 ? (
        <p className="muted small" style={{ padding: 16 }}>No properties yet. Add one from ☰ Manage properties, then come back here to add descriptions and photos.</p>
      ) : (
        <div className="listings-layout">
          <aside className="listings-index">
            <div className="listings-index-head">Properties</div>
            {properties.map((p) => (
              <button key={p.id} className={`listings-index-item ${p.id === selectedId ? 'active' : ''}`} onClick={() => setSelectedId(p.id)}>
                <span className="li-name">{p.name || 'Untitled property'}</span>
                <span className="li-sub">{p.units.length} unit{p.units.length === 1 ? '' : 's'}{p.photos.length ? ` · ${p.photos.length} photo${p.photos.length === 1 ? '' : 's'}` : ''}</span>
              </button>
            ))}
          </aside>

          <div className="listings-detail">
            {(() => {
              const p = properties.find((x) => x.id === selectedId) || properties[0];
              if (!p) return null;
              return (
                <section key={p.id} className="listing-card">
                  <div className="listing-head">
                    <input className="listing-name" placeholder="Property name" value={p.name} onChange={(e) => editProp(p.id, { name: e.target.value })} />
                    <input className="listing-addr" placeholder="Property address" value={p.address || ''} onChange={(e) => editProp(p.id, { address: e.target.value })} />
                    <button className="ghost save" onClick={() => saveProp(p)}>💾 Save</button>
                  </div>
                  <textarea className="listing-desc" placeholder="Property description — paste from your Airbnb listing…"
                    value={p.description || ''} onChange={(e) => editProp(p.id, { description: e.target.value })} />
                  <PhotoGrid photos={p.photos} busy={busyPhoto === p.id}
                    onAdd={(files) => addPhotos('property', p.id, null, files)}
                    onCover={(id) => coverPhoto('property', p.id, null, id)}
                    onDelete={(id) => deletePhoto('property', p.id, null, id)} />

                  {p.units.length > 0 && <div className="units-label">Units</div>}
                  {p.units.map((u) => (
                    <div key={u.id} className="listing-unit">
                      <div className="listing-head">
                        <input className="listing-name sm" value={u.name} onChange={(e) => editUnit(p.id, u.id, { name: e.target.value })} />
                        <label className="cap">Sleeps
                          <input type="number" min="0" value={u.capacity ?? ''} onChange={(e) => editUnit(p.id, u.id, { capacity: e.target.value === '' ? null : Number(e.target.value) })} />
                        </label>
                        <button className="ghost save" onClick={() => saveUnit(u)}>💾 Save</button>
                      </div>
                      <textarea className="listing-desc" placeholder="Unit description (optional — overrides/adds to the property description)…"
                        value={u.description || ''} onChange={(e) => editUnit(p.id, u.id, { description: e.target.value })} />
                      <PhotoGrid photos={u.photos} busy={busyPhoto === u.id}
                        onAdd={(files) => addPhotos('unit', p.id, u.id, files)}
                        onCover={(id) => coverPhoto('unit', p.id, u.id, id)}
                        onDelete={(id) => deletePhoto('unit', p.id, u.id, id)} />
                    </div>
                  ))}
                  <p className="muted small" style={{ marginTop: 10 }}>
                    Photos are resized in your browser before upload and stored with your data. The <b>★</b> sets the cover photo. These descriptions and photos will feed the public booking site.
                  </p>
                </section>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
