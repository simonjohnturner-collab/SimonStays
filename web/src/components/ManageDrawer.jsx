import { useState } from 'react';

// Slide-over menu opened from the hamburger: add / rename / remove a property,
// add a booking (pick the unit), and manage units.
export default function ManageDrawer({
  properties, onClose,
  onAddProperty, onRenameProperty, onDeleteProperty,
  onAddUnit, onDeleteUnit, onOpenUnit, onAddBooking,
}) {
  const units = properties.flatMap((p) => p.units.map((u) => ({ ...u, label: `${p.name} · ${u.name}` })));
  const [pickUnit, setPickUnit] = useState('');

  return (
    <div className="overlay right" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Menu</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>

        <button className="wide" onClick={onAddProperty}>➕ Add a property</button>

        <section>
          <h4>Add a booking</h4>
          {units.length === 0 ? (
            <p className="muted small">Add a property and a unit first.</p>
          ) : (
            <div className="add-chan">
              <select value={pickUnit} onChange={(e) => setPickUnit(e.target.value)}>
                <option value="">Choose a unit…</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
              <button disabled={!pickUnit} onClick={() => { const u = units.find((x) => x.id === pickUnit); if (u) onAddBooking(u); }}>Add</button>
            </div>
          )}
        </section>

        <section>
          <h4>Properties</h4>
          {properties.length === 0 && <p className="muted small">No properties yet.</p>}
          {properties.map((p) => (
            <div key={p.id} className="prop manage">
              <div className="prop-name">
                <span>{p.name}</span>
                <span className="prop-actions">
                  <button className="del" title="Rename property" onClick={() => onRenameProperty(p)}>✎</button>
                  <button className="del" title="Delete property" onClick={() => onDeleteProperty(p)}>×</button>
                </span>
              </div>
              <div className="units">
                {p.units.map((u) => (
                  <span key={u.id} className="unit-chip-wrap">
                    <button className="unit-chip" onClick={() => onOpenUnit(u)}>{u.name}</button>
                    <button className="del sm" title="Delete unit" onClick={() => onDeleteUnit(u)}>×</button>
                  </span>
                ))}
                <button className="mini" onClick={() => onAddUnit(p.id)}>+ unit</button>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
