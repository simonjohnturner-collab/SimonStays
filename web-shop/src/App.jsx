import { useEffect, useState } from 'react';
import { api, photoUrl } from './api.js';

const money = (cents) => `R${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const CONTACT = {
  phone: import.meta.env.VITE_CONTACT_PHONE || '+27 82 853 1554',
  email: import.meta.env.VITE_CONTACT_EMAIL || 'stay@simonstays.com',
};

export default function App() {
  const [propertyId, setPropertyId] = useState(null);
  const [search, setSearch] = useState({ checkIn: '', checkOut: '', guests: '' });
  return (
    <div className="ss">
      <header className="ss-header">
        <button className="ss-brand" onClick={() => setPropertyId(null)}>Simon<span>Stays</span></button>
        <div className="ss-contact-mini">Questions? <a href={`tel:${CONTACT.phone}`}>{CONTACT.phone}</a></div>
      </header>

      {propertyId
        ? <Detail id={propertyId} search={search} onBack={() => setPropertyId(null)} />
        : <Browse search={search} setSearch={setSearch} onOpen={setPropertyId} />}

      <footer className="ss-footer">
        <div className="ss-foot-lead">Not seeing the dates or price you want? Call or email us directly — we're happy to help.</div>
        <div className="ss-foot-links"><a href={`tel:${CONTACT.phone}`}>{CONTACT.phone}</a> · <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a></div>
      </footer>
    </div>
  );
}

function Browse({ search, setSearch, onOpen }) {
  const [draft, setDraft] = useState(search);
  const [props, setProps] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const filtered = !!(search.checkIn && search.checkOut);

  useEffect(() => {
    setLoading(true); setErr(null);
    api.properties(search)
      .then((r) => setProps(r.properties))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [search]);

  function submit(e) {
    e.preventDefault();
    if (draft.checkIn && draft.checkOut && draft.checkOut <= draft.checkIn) { setErr('Check-out must be after check-in.'); return; }
    if ((draft.checkIn && !draft.checkOut) || (draft.checkOut && !draft.checkIn)) { setErr('Please pick both dates, or leave both empty.'); return; }
    setSearch({ ...draft });
  }
  function clear() { const empty = { checkIn: '', checkOut: '', guests: '' }; setDraft(empty); setSearch(empty); }

  return (
    <>
      <form className="ss-search" onSubmit={submit}>
        <label>Check-in<input type="date" value={draft.checkIn} onChange={(e) => setDraft((d) => ({ ...d, checkIn: e.target.value }))} /></label>
        <label>Check-out<input type="date" value={draft.checkOut} min={draft.checkIn || undefined} onChange={(e) => setDraft((d) => ({ ...d, checkOut: e.target.value }))} /></label>
        <label>Guests<input type="number" min="1" placeholder="Any" value={draft.guests} onChange={(e) => setDraft((d) => ({ ...d, guests: e.target.value }))} /></label>
        <button className="ss-btn" type="submit">Search</button>
        {filtered && <button type="button" className="ss-btn ghost" onClick={clear}>Clear</button>}
      </form>

      {filtered && (
        <div className="ss-msg small ss-searchnote">
          Places free for <b>{search.checkIn} → {search.checkOut}</b>{search.guests ? ` · ${search.guests}+ guests` : ''}.
        </div>
      )}

      {err ? <p className="ss-msg err">{err}</p>
        : loading || !props ? <p className="ss-msg">Loading places to stay…</p>
        : !props.length ? <p className="ss-msg">{filtered ? 'No places are free for those dates — try different dates, or call us.' : 'No places listed yet — check back soon.'}</p>
        : (
        <main className="ss-grid">
          {props.map((p) => (
            <button key={p.id} className="ss-card" onClick={() => onOpen(p.id)}>
              <div className="ss-card-img">
                {p.coverPhotoId ? <img src={photoUrl(p.coverPhotoId)} alt={p.name} loading="lazy" /> : <div className="ss-noimg">No photo yet</div>}
              </div>
              <div className="ss-card-body">
                <div className="ss-card-name">{p.name}</div>
                {p.address && <div className="ss-card-addr">{p.address}</div>}
                <div className="ss-card-meta">
                  {p.maxCapacity ? <span>👥 up to {p.maxCapacity}</span> : null}
                  {filtered && p.stayFromCents != null
                    ? <span className="ss-from">{money(p.stayFromCents)} total</span>
                    : p.fromNightlyCents != null ? <span className="ss-from">from {money(p.fromNightlyCents)}/night</span> : null}
                </div>
              </div>
            </button>
          ))}
        </main>
      )}
    </>
  );
}

function Detail({ id, search, onBack }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.property(id).then((r) => setP(r.property)).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <p className="ss-msg err">{err}</p>;
  if (!p) return <p className="ss-msg">Loading…</p>;
  return (
    <main className="ss-detail">
      <button className="ss-back" onClick={onBack}>← All places</button>
      <h1>{p.name}</h1>
      {p.address && <div className="ss-addr">{p.address}</div>}
      <Gallery photos={p.photos} />
      {p.description && <p className="ss-desc">{p.description}</p>}
      <h2>Choose your room &amp; dates</h2>
      {p.units.map((u) => <UnitBooker key={u.id} unit={u} initial={search} />)}
    </main>
  );
}

function Gallery({ photos }) {
  const [active, setActive] = useState(0);
  if (!photos || !photos.length) return null;
  return (
    <div className="ss-gallery">
      <img className="ss-hero" src={photoUrl(photos[active].id)} alt="" />
      {photos.length > 1 && (
        <div className="ss-thumbs">
          {photos.map((ph, i) => (
            <img key={ph.id} className={i === active ? 'on' : ''} src={photoUrl(ph.id)} alt="" onClick={() => setActive(i)} />
          ))}
        </div>
      )}
    </div>
  );
}

function UnitBooker({ unit, initial }) {
  const [checkIn, setCheckIn] = useState(initial?.checkIn || '');
  const [checkOut, setCheckOut] = useState(initial?.checkOut || '');
  const [guests, setGuests] = useState(initial?.guests ? Number(initial.guests) : 1);
  const [q, setQ] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [booked, setBooked] = useState([]);
  const [form, setForm] = useState(null);
  const [confirmed, setConfirmed] = useState(null);

  useEffect(() => { api.calendar(unit.id).then((r) => setBooked(r.booked || [])).catch(() => {}); }, [unit.id]);

  async function getQuote() {
    setErr(''); setQ(null); setConfirmed(null);
    if (!checkIn || !checkOut || checkOut <= checkIn) { setErr('Pick a check-in and a later check-out date.'); return; }
    setBusy(true);
    try { const r = await api.quote({ unitId: unit.id, checkIn, checkOut }); setQ(r.quote); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function doBook(details) {
    setErr(''); setBusy(true);
    try {
      const r = await api.book({ unitId: unit.id, checkIn, checkOut, guests, ...details });
      const paid = await api.pay(r.bookingId, {}); // simulate mode confirms immediately
      setConfirmed(paid); setForm(null); setQ(null);
      api.calendar(unit.id).then((rr) => setBooked(rr.booked || [])).catch(() => {});
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (confirmed) {
    return (
      <div className="ss-unit ss-confirmed">
        <div className="ss-conf-title">✅ Booking confirmed</div>
        <div>{confirmed.property} — {confirmed.unit}</div>
        <div>{confirmed.booking.checkIn} → {confirmed.booking.checkOut}</div>
        {confirmed.accessCode
          ? <div className="ss-code">Your door code: <b>{confirmed.accessCode}</b></div>
          : <div className="ss-muted">We'll send your access details before check-in.</div>}
        <button className="ss-btn ghost" onClick={() => setConfirmed(null)}>Book another stay</button>
      </div>
    );
  }

  return (
    <div className="ss-unit">
      <div className="ss-unit-head">
        <div className="ss-unit-name">{unit.name}</div>
        <div className="ss-unit-meta">
          {unit.capacity ? `Sleeps ${unit.capacity}` : ''}
          {unit.fromNightlyCents != null ? `${unit.capacity ? ' · ' : ''}from ${money(unit.fromNightlyCents)}/night` : ''}
        </div>
      </div>
      {unit.description && <p className="ss-unit-desc">{unit.description}</p>}
      {unit.photos && unit.photos.length > 0 && (
        <div className="ss-unit-thumbs">{unit.photos.slice(0, 5).map((ph) => <img key={ph.id} src={photoUrl(ph.id)} alt="" loading="lazy" />)}</div>
      )}

      {!unit.hasPricing ? (
        <div className="ss-muted">Online booking isn't set up for this room yet — please call us to book.</div>
      ) : (
        <>
          <div className="ss-dates">
            <label>Check-in<input type="date" value={checkIn} onChange={(e) => { setCheckIn(e.target.value); setQ(null); }} /></label>
            <label>Check-out<input type="date" value={checkOut} onChange={(e) => { setCheckOut(e.target.value); setQ(null); }} /></label>
            <label>Guests<input type="number" min="1" value={guests} onChange={(e) => setGuests(Number(e.target.value))} /></label>
            <button className="ss-btn" disabled={busy} onClick={getQuote}>{busy ? '…' : 'Check price'}</button>
          </div>
          {booked.length > 0 && <div className="ss-booked ss-muted">Already booked: {booked.map((b) => `${b.checkIn} → ${b.checkOut}`).join('  ·  ')}</div>}
          {err && <div className="ss-msg err small">{err}</div>}
          {q && !form && (
            <div className="ss-quote">
              <div className="ss-quote-line"><span>{q.nights} night{q.nights === 1 ? '' : 's'}</span><span>{money(q.accommodationCents)}</span></div>
              {q.discountCents > 0 && <div className="ss-quote-line"><span>Discount ({q.discountPercent}%)</span><span>−{money(q.discountCents)}</span></div>}
              {q.cleaningCents > 0 && <div className="ss-quote-line"><span>Cleaning</span><span>{money(q.cleaningCents)}</span></div>}
              {q.breakageCents > 0 && <div className="ss-quote-line"><span>Breakage deposit</span><span>{money(q.breakageCents)}</span></div>}
              <div className="ss-quote-total"><span>Total</span><span>{money(q.totalCents)}</span></div>
              <button className="ss-btn wide" onClick={() => setForm({ guestName: '', guestEmail: '', guestPhone: '', message: '' })}>Book &amp; pay</button>
            </div>
          )}
          {form && (
            <GuestForm form={form} setForm={setForm} busy={busy} total={q && q.totalCents}
              onSubmit={doBook} onCancel={() => setForm(null)} />
          )}
        </>
      )}
    </div>
  );
}

function GuestForm({ form, setForm, busy, total, onSubmit, onCancel }) {
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.guestName.trim() && (form.guestEmail.trim() || form.guestPhone.trim());
  return (
    <div className="ss-guestform">
      <div className="ss-gf-title">Your details</div>
      <input placeholder="Full name" value={form.guestName} onChange={(e) => set('guestName', e.target.value)} />
      <input placeholder="Email" value={form.guestEmail} onChange={(e) => set('guestEmail', e.target.value)} />
      <input placeholder="Phone" value={form.guestPhone} onChange={(e) => set('guestPhone', e.target.value)} />
      <textarea placeholder="Anything we should know? (optional)" value={form.message} onChange={(e) => set('message', e.target.value)} />
      <div className="ss-gf-actions">
        <button className="ss-btn ghost" onClick={onCancel} disabled={busy}>Back</button>
        <button className="ss-btn wide" disabled={!valid || busy} onClick={() => onSubmit(form)}>
          {busy ? 'Confirming…' : `Pay ${total != null ? money(total) : ''} & confirm`}
        </button>
      </div>
      <div className="ss-muted small">Online card payment is being connected. For now this reserves your dates and we'll arrange payment with you directly.</div>
    </div>
  );
}
