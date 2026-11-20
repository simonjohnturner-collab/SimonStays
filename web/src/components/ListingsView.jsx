import { useEffect, useRef, useState } from 'react';
import { api, photoUrl } from '../api.js';
import { navigate } from '../router.js';

// A rand amount kept in cents. The text is held locally so "12." can be typed.
function RandInput({ cents, onChange, onBlur, placeholder }) {
  const show = (c) => (c == null ? '' : String(c / 100));
  const [text, setText] = useState(show(cents));
  useEffect(() => { setText((t) => (Math.round(Number(t) * 100) === cents || (t === '' && cents == null) ? t : show(cents))); }, [cents]);
  return (
    <input inputMode="decimal" placeholder={placeholder} value={text}
      onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ''); setText(v); onChange(v === '' ? null : Math.round(Number(v) * 100)); }}
      onBlur={onBlur} />
  );
}

// What a Township Stay still needs before it can go live (matches server/src/utils/township.js).
function townshipMissing(p) {
  const m = [];
  if (!String(p.name || '').trim()) m.push('a name');
  if (!p.monthlyRentCents && !p.weeklyRentCents) m.push('a monthly or weekly rent');
  if (!p.contactPhone && !p.contactEmail) m.push('a contact phone or email');
  if (!(p.photos || []).length) m.push('at least one photo');
  return m;
}

// Must match server/src/utils/policy.js (shown on the shopfront when a property
// hasn't set its own). Pre-filled here so hosts can tweak per listing.
const DEFAULT_CANCELLATION_POLICY =
  'You may cancel within 1 hour of booking, or at any time while your check-in date is 30 days or more away, for a full refund. '
  + 'If your check-in date is between 30 and 14 days away, you are eligible for a 50% refund. '
  + 'If you cancel within 14 days of your check-in date, the booking is non-refundable (any refund is at the property owner’s discretion).';

// A click-to-drop-a-pin map (Leaflet, loaded from CDN in index.html). You can
// type an address to zoom the map there first, then click to drop the pin.
// Reports the picked lat/lng back to the parent.
function MapPicker({ lat, lng, onPick }) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const [addr, setAddr] = useState('');
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    const L = window.L;
    if (!L || !ref.current) return;
    const dot = (la, ln) => L.circleMarker([la, ln], { radius: 9, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.9, weight: 2 });
    const has = lat != null && lng != null;
    const map = L.map(ref.current).setView(has ? [lat, lng] : [-26.2041, 28.0473], has ? 15 : 10);
    mapRef.current = map;
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(map);
    if (has) markerRef.current = dot(lat, lng).addTo(map);
    map.on('click', (e) => {
      const la = Number(e.latlng.lat.toFixed(6)), ln = Number(e.latlng.lng.toFixed(6));
      if (markerRef.current) markerRef.current.setLatLng([la, ln]); else markerRef.current = dot(la, ln).addTo(map);
      onPick(la, ln);
    });
    setTimeout(() => map.invalidateSize(), 120);
    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
    // eslint-disable-next-line
  }, []);

  // Geocode the typed address (free OpenStreetMap Nominatim) and zoom there.
  // Does not drop the pin — the user still clicks the exact spot.
  async function search(e) {
    e.preventDefault();
    const q = addr.trim();
    if (!q || !mapRef.current) return;
    setSearching(true); setNote('');
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await r.json();
      if (!data || !data.length) { setNote('Address not found — try adding the suburb or city.'); return; }
      mapRef.current.setView([Number(data[0].lat), Number(data[0].lon)], 17);
      setNote('Zoomed in — now click the map to drop the pin.');
    } catch (err) { setNote('Search failed — check your connection and try again.'); }
    finally { setSearching(false); }
  }

  if (!window.L) return <div className="map-pick map-off">Map unavailable — enter coordinates below.</div>;
  return (
    <div className="map-wrap">
      <form className="map-search" onSubmit={search}>
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Type an address or place to zoom the map…" />
        <button type="submit" className="secondary" disabled={searching}>{searching ? 'Searching…' : '🔍 Find'}</button>
      </form>
      {note && <div className="muted small map-search-note">{note}</div>}
      <div className="map-pick" ref={ref} />
    </div>
  );
}

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

function PhotoGrid({ photos, onAdd, onCover, onDelete, onReorder, busy }) {
  const [drag, setDrag] = useState(null); // index being dragged
  const [over, setOver] = useState(null); // index currently dragged over
  function drop(to) {
    const from = drag;
    setDrag(null); setOver(null);
    if (from == null || from === to) return;
    const ids = photos.map((p) => p.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    onReorder && onReorder(ids);
  }
  return (
    <>
    {photos.length > 1 && <p className="muted small photo-hint">Drag photos to reorder — the first one is the cover.</p>}
    <div className="photo-grid">
      {photos.map((p, i) => (
        <div key={p.id}
          className={`photo-tile ${drag === i ? 'dragging' : ''} ${over === i && drag !== i ? 'drag-over' : ''}`}
          draggable
          onDragStart={() => setDrag(i)}
          onDragEnter={() => setOver(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => drop(i)}
          onDragEnd={() => { setDrag(null); setOver(null); }}>
          <img src={photoUrl(p.id)} alt={p.filename || 'photo'} loading="lazy" draggable={false} />
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
    </>
  );
}

export default function ListingsView({ onClose }) {
  const [properties, setProperties] = useState(null);
  const [selectedId, setSelectedId] = useState(null); // property shown in the detail pane
  const [msg, setMsg] = useState('');
  const [busyPhoto, setBusyPhoto] = useState(null); // id of the property/unit currently uploading
  const [dirty, setDirty] = useState(false); // unsaved edits pending
  const [saving, setSaving] = useState(false);
  const [calBusy, setCalBusy] = useState(null); // unit id whose calendar is saving
  const [ts, setTs] = useState(null); // Township Stays status (plan, which listings are live)

  async function load() {
    const r = await api.getListings();
    setProperties(r.properties);
    setSelectedId((cur) => (cur && r.properties.some((p) => p.id === cur) ? cur : r.properties[0]?.id || null));
  }
  useEffect(() => { load(); api.township().then(setTs).catch(() => {}); }, []);

  // ---- local edits (kept in state; saved on the Save button) ----
  const editProp = (pid, patch) => { setDirty(true); setProperties((ps) => ps.map((p) => (p.id === pid ? { ...p, ...patch } : p))); };
  const editUnit = (pid, uid, patch) => { setDirty(true);
    setProperties((ps) => ps.map((p) => (p.id !== pid ? p : { ...p, units: p.units.map((u) => (u.id === uid ? { ...u, ...patch } : u)) }))); };

  async function saveProp(p, quiet) {
    setMsg('');
    await api.saveProperty(p.id, {
      name: p.name, address: p.address || '', description: p.description || '',
      latitude: p.latitude ?? null, longitude: p.longitude ?? null,
      cancellationPolicy: p.cancellationPolicy ?? '',
      bookingMode: p.bookingMode || 'instant',
      ...(p.kind === 'township' ? {
        areaName: p.areaName || '', areaDescription: p.areaDescription || '',
        monthlyRentCents: p.monthlyRentCents ?? null, weeklyRentCents: p.weeklyRentCents ?? null, depositCents: p.depositCents ?? null,
        contactName: p.contactName || '', contactPhone: p.contactPhone || '', contactEmail: p.contactEmail || '',
        tsHidden: !!p.tsHidden,
      } : {}),
    });
    if (p.kind === 'township') api.township().then(setTs).catch(() => {});
    if (!quiet) flash('Saved.');
  }
  async function saveUnit(u, quiet) {
    setMsg('');
    await api.saveUnit(u.id, {
      name: u.name, capacity: u.capacity, description: u.description || '',
      minNights: u.minNights ?? null,
      bedrooms: u.bedrooms ?? null, bathrooms: u.bathrooms ?? null,
      wifiName: u.wifiName || '', wifiPassword: u.wifiPassword || '',
      checkInTime: u.checkInTime || '', checkOutTime: u.checkOutTime || '',
      security: u.security || '', access: u.access || '',
      accessMethod: u.accessMethod || '', smartLockUrl: u.smartLockUrl || '',
      backupPower: u.backupPower || '', backupWater: u.backupWater || '',
      parkingBays: u.parkingBays ?? null, parkingNotes: u.parkingNotes || '',
    });
    if (!quiet) flash('Saved.');
  }
  // Save the whole property + every unit at once (the top "Save all" button).
  async function saveAll(p) {
    setSaving(true); setMsg('');
    try {
      await saveProp(p, true);
      for (const u of p.units) { await saveUnit(u, true); }
      setDirty(false); flash('All changes saved.');
    } catch (e) { setMsg(e.message || 'Save failed'); }
    finally { setSaving(false); }
  }
  // Auto-save a single record when a field loses focus, so nothing is lost.
  async function autoSaveProp(p) { try { await saveProp(p, true); setDirty(false); flash('Saved.'); } catch (e) { setMsg(e.message); } }
  async function autoSaveUnit(u) { try { await saveUnit(u, true); setDirty(false); flash('Saved.'); } catch (e) { setMsg(e.message); } }
  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 1500); }

  // Calendar/channel sync (moved here from the old unit panel).
  async function saveCalendarLink(u) {
    setCalBusy(u.id); setMsg('');
    try {
      await api.setCalendar(u.id, (u.importUrl || '').trim());
      if ((u.importUrl || '').trim()) await api.syncUnit(u.id);
      const ch = await api.listChannels(u.id).catch(() => ({ channels: [] }));
      const c = (ch.channels || [])[0];
      setProperties((ps) => ps.map((pp) => ({ ...pp, units: pp.units.map((x) => (x.id === u.id ? { ...x, channelStatus: (c && c.lastStatus) || '' } : x)) })));
      flash((u.importUrl || '').trim() ? 'Calendar saved & synced.' : 'Calendar link cleared.');
    } catch (e) { setMsg(e.message); } finally { setCalBusy(null); }
  }
  function copyFeed(u) {
    try { navigator.clipboard.writeText(u.feedUrl || ''); flash('Lock link copied.'); }
    catch (e) { setMsg('Copy failed — select the link and copy it manually.'); }
  }

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
  // Persist a new drag-and-drop order: sort = position in the list (0 = cover).
  async function reorderPhotos(kind, pid, uid, orderedIds) {
    setPhotos(kind, pid, uid, (arr) => {
      const byId = new Map(arr.map((x) => [x.id, x]));
      return orderedIds.map((id, i) => ({ ...byId.get(id), sort: i })).filter((x) => x && x.id);
    });
    try { await Promise.all(orderedIds.map((id, i) => api.setPhotoSort(id, i))); flash('Photo order saved.'); }
    catch (e) { setMsg(e.message); }
  }
  async function deletePhoto(kind, pid, uid, id) {
    if (!window.confirm('Delete this photo?')) return;
    setPhotos(kind, pid, uid, (arr) => arr.filter((x) => x.id !== id));
    try { await api.deletePhoto(id); } catch (e) { setMsg(e.message); }
  }

  // ---- property & unit management (moved here from the old property menu) ----
  async function addProperty(kind) {
    const township = kind === 'township';
    const name = window.prompt(township ? 'Name of your Township Stay (e.g. Room in Orlando West)' : 'New property name');
    if (!name || !name.trim()) return;
    try {
      const r = await api.createProperty(name.trim(), undefined, township ? 'township' : undefined);
      await load(); if (r && r.property) setSelectedId(r.property.id);
      flash(township ? 'Township Stay added.' : 'Property added.');
    } catch (e) { setMsg(e.message); }
  }
  async function addUnit(pid) {
    const name = window.prompt('New unit name (e.g. 23, or Main)');
    if (!name || !name.trim()) return;
    try { await api.createUnit(pid, name.trim()); await load(); flash('Unit added.'); }
    catch (e) { setMsg(e.message); }
  }
  async function removeProperty(p) {
    if (!window.confirm(`Delete property “${p.name}” and ALL its units, bookings and photos? This cannot be undone.`)) return;
    try { await api.deleteProperty(p.id); setSelectedId(null); await load(); flash('Property deleted.'); }
    catch (e) { setMsg(e.message); }
  }
  async function removeUnit(u) {
    if (!window.confirm(`Delete unit “${u.name}” and its bookings & photos? This cannot be undone.`)) return;
    try { await api.deleteUnit(u.id); await load(); flash('Unit deleted.'); }
    catch (e) { setMsg(e.message); }
  }
  async function moveProp(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= properties.length) return;
    const ids = properties.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api.reorderProperties(ids); await load(); } catch (e) { setMsg(e.message); }
  }

  // A Township Stay: a longer rental on SimonStays Township Stays. No units or
  // bookings: photos, the area, the place, rents and the contact details tenants unlock.
  function townshipDetail(p) {
    const missing = townshipMissing(p);
    const info = ts && (ts.listings || []).find((x) => x.id === p.id);
    const live = !!(info && info.live);
    const planNote = !ts ? '' : !ts.plan ? 'Choose a plan (monthly fee or pay per click) on your Township Stays page.'
      : ts.plan === 'monthly' && !live && !missing.length && !p.tsHidden ? 'Pay this month’s listing fee on your Township Stays page.'
      : ts.plan === 'click' && !ts.activated ? 'Load credit on your Township Stays page.' : '';
    return (
      <section key={p.id} className="listing-card">
        <div className="listing-head">
          <input className="listing-name" placeholder="Listing name, e.g. Room in Orlando West" value={p.name} onChange={(e) => editProp(p.id, { name: e.target.value })} />
          <button className="ghost save" onClick={() => saveProp(p)}>💾 Save</button>
        </div>
        <div className={`ts-status ${live ? 'ok' : ''}`}>
          {p.tsHidden ? 'Hidden: tenants can’t see this listing.'
            : live ? 'Live on SimonStays Township Stays.'
            : <>Not live yet.{missing.length ? ` It still needs ${missing.join(', ')}.` : ''} {planNote}</>}
          {' '}<a onClick={() => navigate('/listings/township')}>Plan, credit and leads →</a>
        </div>
        <div className="listing-prop-actions">
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={!p.tsHidden}
              onChange={(e) => { const np = { ...p, tsHidden: !e.target.checked }; editProp(p.id, { tsHidden: np.tsHidden }); autoSaveProp(np); }} />
            Show on Township Stays
          </label>
          <span className="spacer" />
          <button className="mini danger" onClick={() => removeProperty(p)}>🗑 Delete listing</button>
        </div>

        <div className="attr-section">
          <div className="attr-head">Photos <span className="muted small">— the first one is the cover</span></div>
          <PhotoGrid photos={p.photos} busy={busyPhoto === p.id}
            onAdd={(files) => addPhotos('property', p.id, null, files)}
            onCover={(id) => coverPhoto('property', p.id, null, id)}
            onReorder={(ids) => reorderPhotos('property', p.id, null, ids)}
            onDelete={(id) => deletePhoto('property', p.id, null, id)} />
        </div>

        <div className="attr-section">
          <div className="attr-head">The area</div>
          <div className="attr-grid">
            <label className="attr wide">Area <span className="muted small">— township and section</span>
              <input value={p.areaName || ''} placeholder="e.g. Soweto, Orlando West" onChange={(e) => editProp(p.id, { areaName: e.target.value })} onBlur={() => autoSaveProp(p)} /></label>
          </div>
          <textarea className="listing-desc" rows={4} placeholder="About the area: taxis and transport, shops, schools, clinics, how safe it is…"
            value={p.areaDescription || ''} onChange={(e) => editProp(p.id, { areaDescription: e.target.value })} onBlur={() => autoSaveProp(p)} />
        </div>

        <div className="attr-section">
          <div className="attr-head">The place</div>
          <textarea className="listing-desc" rows={5} placeholder="About the place: a room or the whole house, beds, bathroom, kitchen, electricity and water, parking, house rules…"
            value={p.description || ''} onChange={(e) => editProp(p.id, { description: e.target.value })} onBlur={() => autoSaveProp(p)} />
        </div>

        <div className="attr-section">
          <div className="attr-head">Pricing <span className="muted small">— in rand</span></div>
          <div className="attr-grid">
            <label className="attr">Monthly rent<RandInput cents={p.monthlyRentCents ?? null} placeholder="e.g. 3500" onChange={(c) => editProp(p.id, { monthlyRentCents: c })} onBlur={() => autoSaveProp(p)} /></label>
            <label className="attr">Weekly rent<RandInput cents={p.weeklyRentCents ?? null} placeholder="optional" onChange={(c) => editProp(p.id, { weeklyRentCents: c })} onBlur={() => autoSaveProp(p)} /></label>
            <label className="attr">Deposit<RandInput cents={p.depositCents ?? null} placeholder="e.g. 3500" onChange={(c) => editProp(p.id, { depositCents: c })} onBlur={() => autoSaveProp(p)} /></label>
          </div>
        </div>

        <div className="attr-section">
          <div className="attr-head">Contact details <span className="muted small">— hidden until a tenant taps Contact details</span></div>
          <div className="attr-grid">
            <label className="attr">Name<input value={p.contactName || ''} placeholder="Who tenants should ask for" onChange={(e) => editProp(p.id, { contactName: e.target.value })} onBlur={() => autoSaveProp(p)} /></label>
            <label className="attr">Phone<input value={p.contactPhone || ''} placeholder="e.g. 072 123 4567" onChange={(e) => editProp(p.id, { contactPhone: e.target.value })} onBlur={() => autoSaveProp(p)} /></label>
            <label className="attr wide">Email<input type="email" value={p.contactEmail || ''} placeholder="optional" onChange={(e) => editProp(p.id, { contactEmail: e.target.value })} onBlur={() => autoSaveProp(p)} /></label>
          </div>
        </div>

        <div className="attr-section">
          <div className="attr-head">Location <span className="muted small">— optional; click the map to drop a pin</span></div>
          <MapPicker lat={p.latitude} lng={p.longitude} onPick={(la, ln) => editProp(p.id, { latitude: la, longitude: ln })} />
          <div className="map-coords">
            {p.latitude != null && p.longitude != null
              ? <>📍 {p.latitude}, {p.longitude} <button className="mini" onClick={() => editProp(p.id, { latitude: null, longitude: null })}>Clear pin</button></>
              : <span className="muted small">No pin dropped yet.</span>}
          </div>
          <button className="ghost save" style={{ marginTop: 10 }} onClick={() => saveProp(p)}>💾 Save location</button>
        </div>
      </section>
    );
  }

  return (
    <div className="invoices-view">
      <header className="topbar">
        <span className="host">Listings</span>
        <div className="spacer" />
        {dirty && <span className="unsaved-dot" title="You have unsaved changes">● Unsaved</span>}
        {msg && <span className="small" style={{ marginRight: 8 }}>{msg}</span>}
        {properties && properties.length > 0 && (() => {
          const cur = properties.find((x) => x.id === selectedId) || properties[0];
          return <button className={dirty ? '' : 'secondary'} disabled={saving} onClick={() => cur && saveAll(cur)}>{saving ? 'Saving…' : '💾 Save all'}</button>;
        })()}
      </header>

      {!properties ? <p className="muted small" style={{ padding: 16 }}>Loading…</p> : properties.length === 0 ? (
        <div style={{ padding: 16 }}>
          <p className="muted small">No properties yet.</p>
          <button onClick={() => addProperty()}>➕ Add a property</button>{' '}
          <button className="secondary" onClick={() => addProperty('township')}>➕ Add a Township Stay</button>
        </div>
      ) : (
        <div className="listings-layout">
          <aside className="listings-index">
            <div className="listings-index-head">Properties</div>
            {properties.filter((p) => p.kind !== 'township').map((p) => (
              <button key={p.id} className={`listings-index-item ${p.id === selectedId ? 'active' : ''}`} onClick={() => setSelectedId(p.id)}>
                <span className="li-name">{p.name || 'Untitled property'}</span>
                <span className="li-sub">{p.units.length} unit{p.units.length === 1 ? '' : 's'}{p.photos.length ? ` · ${p.photos.length} photo${p.photos.length === 1 ? '' : 's'}` : ''}</span>
              </button>
            ))}
            <button className="li-add" onClick={() => addProperty()}>➕ Add a property</button>
            <div className="listings-index-head" style={{ marginTop: 14 }}>Township Stays</div>
            {properties.filter((p) => p.kind === 'township').map((p) => {
              const live = ts && (ts.listings || []).find((x) => x.id === p.id)?.live;
              return (
                <button key={p.id} className={`listings-index-item ${p.id === selectedId ? 'active' : ''}`} onClick={() => setSelectedId(p.id)}>
                  <span className="li-name">{p.name || 'Untitled Township Stay'}</span>
                  <span className="li-sub">{p.tsHidden ? 'Hidden' : live ? 'Live on Township Stays' : 'Not live yet'}{p.photos.length ? ` · ${p.photos.length} photo${p.photos.length === 1 ? '' : 's'}` : ''}</span>
                </button>
              );
            })}
            <button className="li-add" onClick={() => addProperty('township')}>➕ Add a Township Stay</button>
          </aside>

          <div className="listings-detail">
            {(() => {
              const p = properties.find((x) => x.id === selectedId) || properties[0];
              if (!p) return null;
              if (p.kind === 'township') return townshipDetail(p);
              return (
                <section key={p.id} className="listing-card">
                  <div className="listing-head">
                    <input className="listing-name" placeholder="Property name" value={p.name} onChange={(e) => editProp(p.id, { name: e.target.value })} />
                    <button className="ghost save" onClick={() => saveProp(p)}>💾 Save</button>
                  </div>
                  <div className="listing-prop-actions">
                    {(() => { const pi = properties.findIndex((x) => x.id === p.id); return (<>
                      <button className="mini" title="Move up" disabled={pi <= 0} onClick={() => moveProp(pi, -1)}>▲ up</button>
                      <button className="mini" title="Move down" disabled={pi >= properties.length - 1} onClick={() => moveProp(pi, 1)}>▼ down</button>
                    </>); })()}
                    <span className="spacer" />
                    <button className="mini danger" onClick={() => removeProperty(p)}>🗑 Delete property</button>
                  </div>
                  <textarea className="listing-desc" placeholder="Property description — paste from your Airbnb listing…"
                    value={p.description || ''} onChange={(e) => editProp(p.id, { description: e.target.value })} onBlur={() => autoSaveProp(p)} />
                  <PhotoGrid photos={p.photos} busy={busyPhoto === p.id}
                    onAdd={(files) => addPhotos('property', p.id, null, files)}
                    onCover={(id) => coverPhoto('property', p.id, null, id)}
                    onReorder={(ids) => reorderPhotos('property', p.id, null, ids)}
                    onDelete={(id) => deletePhoto('property', p.id, null, id)} />

                  <div className="attr-section">
                    <div className="attr-head">Location <span className="muted small">— click the map to drop a pin</span></div>
                    <MapPicker lat={p.latitude} lng={p.longitude} onPick={(la, ln) => editProp(p.id, { latitude: la, longitude: ln })} />
                    <div className="map-coords">
                      {p.latitude != null && p.longitude != null
                        ? <>📍 {p.latitude}, {p.longitude} <button className="mini" onClick={() => editProp(p.id, { latitude: null, longitude: null })}>Clear pin</button></>
                        : <span className="muted small">No pin dropped yet — click the map above.</span>}
                    </div>
                    <button className="ghost save" style={{ marginTop: 10 }} onClick={() => saveProp(p)}>💾 Save location</button>
                  </div>

                  <div className="attr-section">
                    <div className="attr-head">How guests book <span className="muted small">— for bookings made on SimonStays</span></div>
                    <div className="book-modes" role="radiogroup" aria-label="How guests book">
                      {[
                        ['instant', '⚡ Instant booking', 'Guests book and pay straight away. No approval needed.'],
                        ['rated', '⭐ Instant for 5-star guests', 'Guests rated 5 stars by their previous hosts book instantly. Everyone else, including new guests, sends a request.'],
                        ['request', '✋ Request to book', 'Every booking is a request. You approve it by sending the invoice, and dates are only held once the guest pays.'],
                      ].map(([mode, label, hint]) => (
                        <label key={mode} className={`book-mode ${(p.bookingMode || 'instant') === mode ? 'on' : ''}`}>
                          <input type="radio" name={`bm-${p.id}`} checked={(p.bookingMode || 'instant') === mode}
                            onChange={() => { const np = { ...p, bookingMode: mode }; editProp(p.id, { bookingMode: mode }); autoSaveProp(np); }} />
                          <span><b>{label}</b><span className="muted small">{hint}</span></span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="attr-section">
                    <div className="attr-head">Cancellation policy <span className="muted small">— shown to guests on SimonStays</span></div>
                    <textarea className="listing-desc" rows={4}
                      value={p.cancellationPolicy != null ? p.cancellationPolicy : DEFAULT_CANCELLATION_POLICY}
                      onChange={(e) => editProp(p.id, { cancellationPolicy: e.target.value })} onBlur={() => autoSaveProp(p)} />
                    <div className="map-coords">
                      <button className="mini" onClick={() => editProp(p.id, { cancellationPolicy: DEFAULT_CANCELLATION_POLICY })}>Reset to standard policy</button>
                    </div>
                  </div>

                  <div className="units-label-row">
                    <div className="units-label">Units</div>
                    <button className="mini" onClick={() => addUnit(p.id)}>➕ Add unit</button>
                  </div>
                  {p.units.map((u) => (
                    <div key={u.id} className="listing-unit">
                      <div className="listing-head">
                        <input className="listing-name sm" value={u.name} onChange={(e) => editUnit(p.id, u.id, { name: e.target.value })} />
                        <label className="cap">Sleeps
                          <input type="number" min="0" value={u.capacity ?? ''} onChange={(e) => editUnit(p.id, u.id, { capacity: e.target.value === '' ? null : Number(e.target.value) })} />
                        </label>
                        <label className="cap">Beds
                          <input type="number" min="0" value={u.bedrooms ?? ''} onChange={(e) => editUnit(p.id, u.id, { bedrooms: e.target.value === '' ? null : Number(e.target.value) })} />
                        </label>
                        <label className="cap">Baths
                          <input type="number" min="0" value={u.bathrooms ?? ''} onChange={(e) => editUnit(p.id, u.id, { bathrooms: e.target.value === '' ? null : Number(e.target.value) })} />
                        </label>
                        <label className="cap" title="Minimum nights per booking — guests can’t book fewer. Leave blank for no minimum.">Min nights
                          <input type="number" min="0" placeholder="—" value={u.minNights ?? ''} onChange={(e) => editUnit(p.id, u.id, { minNights: e.target.value === '' ? null : Number(e.target.value) })} />
                        </label>
                        <button className="ghost save" onClick={() => saveUnit(u)}>💾 Save</button>
                        <button className="mini danger" title="Delete unit" onClick={() => removeUnit(u)}>🗑</button>
                      </div>
                      <textarea className="listing-desc" placeholder="Unit description (optional — overrides/adds to the property description)…"
                        value={u.description || ''} onChange={(e) => editUnit(p.id, u.id, { description: e.target.value })} onBlur={() => autoSaveUnit(u)} />
                      <div className="attr-grid">
                        <label className="attr">Access (stairs/lift)
                          <select value={u.access || ''} onChange={(e) => editUnit(p.id, u.id, { access: e.target.value })}>
                            <option value="">—</option>
                            <option value="Ground floor">Ground floor</option>
                            <option value="Stairs">Stairs</option>
                            <option value="Lift">Lift</option>
                            <option value="Stairs & lift">Stairs &amp; lift</option>
                          </select>
                        </label>
                        <label className="attr">Access method (entry)
                          <select value={u.accessMethod || ''} onChange={(e) => editUnit(p.id, u.id, { accessMethod: e.target.value })}>
                            <option value="">—</option>
                            <option value="Lockbox">Lockbox</option>
                            <option value="Smart lock">Smart lock</option>
                            <option value="Remote garage door control">Remote garage door control</option>
                          </select>
                        </label>
                        {u.accessMethod === 'Smart lock' && (
                          <label className="attr wide">Smart lock link <span className="muted small">(for check‑in/out config)</span>
                            <input value={u.smartLockUrl || ''} placeholder="https://…" onChange={(e) => editUnit(p.id, u.id, { smartLockUrl: e.target.value })} /></label>
                        )}
                        <label className="attr wide">Parking bay number<input value={u.parkingNotes || ''} placeholder="e.g. Bay 12 (basement)" onChange={(e) => editUnit(p.id, u.id, { parkingNotes: e.target.value })} /></label>
                        <label className="attr">Wi‑Fi network<input value={u.wifiName || ''} placeholder="Network name" onChange={(e) => editUnit(p.id, u.id, { wifiName: e.target.value })} /></label>
                        <label className="attr">Wi‑Fi password<input value={u.wifiPassword || ''} placeholder="Password" onChange={(e) => editUnit(p.id, u.id, { wifiPassword: e.target.value })} /></label>
                      </div>
                      <div className="attr-subhead">General</div>
                      <div className="attr-grid">
                        <label className="attr">Check‑in time<input type="time" value={u.checkInTime || ''} onChange={(e) => editUnit(p.id, u.id, { checkInTime: e.target.value })} /></label>
                        <label className="attr">Check‑out time<input type="time" value={u.checkOutTime || ''} onChange={(e) => editUnit(p.id, u.id, { checkOutTime: e.target.value })} /></label>
                        <label className="attr wide">Security<input value={u.security || ''} placeholder="e.g. 24h guard, biometric access, CCTV" onChange={(e) => editUnit(p.id, u.id, { security: e.target.value })} /></label>
                        <label className="attr">Backup power<input value={u.backupPower || ''} placeholder="e.g. Inverter runs lights & wifi" onChange={(e) => editUnit(p.id, u.id, { backupPower: e.target.value })} /></label>
                        <label className="attr">Backup water<input value={u.backupWater || ''} placeholder="e.g. 2500L tank" onChange={(e) => editUnit(p.id, u.id, { backupWater: e.target.value })} /></label>
                      </div>

                      <div className="attr-subhead">Calendar &amp; channel sync</div>
                      <div className="cal-sync">
                        <label className="attr wide">iCal calendar link <span className="muted small">— the channel calendar we pull bookings from</span>
                          <input value={u.importUrl || ''} placeholder="https://…/calendar.ics" onChange={(e) => editUnit(p.id, u.id, { importUrl: e.target.value })} /></label>
                        <div className="cal-sync-row">
                          {u.channelStatus && <span className="muted small">{u.channelStatus}</span>}
                          <span className="spacer" />
                          <button className="ghost" disabled={calBusy === u.id} onClick={() => saveCalendarLink(u)}>{calBusy === u.id ? 'Saving…' : '💾 Save & sync'}</button>
                        </div>
                        <label className="attr wide">Lock link <span className="muted small">— paste into a channel’s “Import calendar” to block these dates</span>
                          <input readOnly value={u.feedUrl || ''} onFocus={(e) => e.target.select()} /></label>
                        <div className="cal-sync-row"><span className="spacer" /><button className="ghost" onClick={() => copyFeed(u)}>📋 Copy lock link</button></div>
                      </div>

                      <PhotoGrid photos={u.photos} busy={busyPhoto === u.id}
                        onAdd={(files) => addPhotos('unit', p.id, u.id, files)}
                        onCover={(id) => coverPhoto('unit', p.id, u.id, id)}
                        onReorder={(ids) => reorderPhotos('unit', p.id, u.id, ids)}
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
