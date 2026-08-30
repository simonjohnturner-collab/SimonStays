import { useState } from 'react';

// Hamburger menu with sub-screens: main → property / booking. Invoicing opens
// the invoices workspace directly.
export default function ManageDrawer({
  properties, bookingsByUnit, onClose,
  onAddProperty, onRenameProperty, onDeleteProperty,
  onAddUnit, onDeleteUnit, onOpenUnit, onEditPricing,
  onAddBooking, onEditBooking, onOpenInvoices,
}) {
  const [view, setView] = useState('main'); // 'main' | 'property' | 'booking' | 'pricing'
  const [pickUnit, setPickUnit] = useState('');

  const units = properties.flatMap((p) => p.units.map((u) => ({ ...u, label: `${p.name} · ${u.name}`, propertyName: p.name })));

  const bookings = [];
  properties.forEach((p) => p.units.forEach((u) => {
    (bookingsByUnit?.[u.id] || []).forEach((b) => {
      if (b.status !== 'cancelled') bookings.push({ ...b, unit: u, unitLabel: `${p.name} · ${u.name}` });
    });
  }));
  bookings.sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1));

  const title = view === 'property' ? 'Add or edit a property' : view === 'booking' ? 'Add or edit a booking'
    : view === 'pricing' ? 'Pricing sheets' : 'Menu';

  return (
    <div className="overlay right" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{view !== 'main' ? <button className="del back" onClick={() => setView('main')}>←</button> : null}{title}</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>

        {view === 'main' && (
          <div className="menu-main">
            <button className="wide menu-item" onClick={() => setView('property')}>🏠 Add or edit a property</button>
            <button className="wide menu-item" onClick={() => setView('booking')}>📅 Add or edit a booking</button>
            <button className="wide menu-item" onClick={() => setView('pricing')}>💲 Pricing sheets</button>
            <button className="wide menu-item" onClick={onOpenInvoices}>🧾 Invoicing</button>
          </div>
        )}

        {view === 'property' && (
          <div>
            <button className="wide" onClick={onAddProperty}>➕ Add a property</button>
            <section>
              <h4>Your properties</h4>
              {properties.length === 0 && <p className="muted small">No properties yet — add your first one above.</p>}
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
        )}

        {view === 'pricing' && (
          <div>
            <p className="muted small">Pricing is per unit. Pick a unit to edit its rate card.</p>
            {units.length === 0 && <p className="muted small">Add a property and a unit first.</p>}
            <div className="booking-list">
              {units.map((u) => (
                <button key={u.id} className="booking-row" onClick={() => onEditPricing(u)}>
                  <span className="br-guest">{u.propertyName} · {u.name}</span>
                  <span className="br-sub">Edit rate card</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {view === 'booking' && (
          <div>
            <section className="first">
              <h4>Create a booking</h4>
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
              <h4>Edit a booking</h4>
              {bookings.length === 0 && <p className="muted small">No bookings yet.</p>}
              <div className="booking-list">
                {bookings.map((b) => (
                  <button key={b.id} className="booking-row" onClick={() => onEditBooking(b, b.unit)}>
                    <span className="br-guest">{b.guestName || '(guest)'}</span>
                    <span className="br-sub">{b.unitLabel} · {b.checkIn.slice(0, 10)} → {b.checkOut.slice(0, 10)}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
