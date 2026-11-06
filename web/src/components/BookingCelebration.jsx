import { useEffect, useRef, useState } from 'react';
import { apiBaseUrl, getToken } from '../api.js';
import { navigate } from '../router.js';

// The "ka-ching": when a SimonStays booking is confirmed, Hosting plays the
// SimonStays booking sound and shows a card with what the host earns. Always
// mounted, on every screen. Polls /account/new-bookings (bookings confirmed since
// the last check, kept per host in localStorage so a reload doesn't replay them).
// Respects the bell's mute. Browsers only play sound after the host has clicked
// or tapped the page once, so the first interaction unlocks it.
const POLL_MS = 30000;
const isMuted = () => { try { return localStorage.getItem('ss_forms_mute') === '1'; } catch { return false; } };
const rand = (c) => 'R' + Math.round(c / 100).toLocaleString('en-ZA');
const day = (s) => new Date(`${s}T12:00:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
const EXAMPLE = { example: true, place: 'Vantage · Unit 409', guestName: 'A guest', checkIn: '2026-12-11', checkOut: '2026-12-13', nights: 2, earnCents: 288000, count: 1 };

export default function BookingCelebration({ hostId }) {
  const [card, setCard] = useState(null);
  const ctxRef = useRef(null);
  const bufRef = useRef(null);
  const key = `ss_booking_seen_${hostId}`;

  function audio() {
    try {
      if (!ctxRef.current) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctxRef.current = new AC(); }
      return ctxRef.current;
    } catch { return null; }
  }
  async function sound() {
    const ctx = audio(); if (!ctx) return null;
    if (!bufRef.current) {
      const r = await fetch(`${apiBaseUrl().replace(/\/$/, '')}/sounds/simonstays-booking.wav`);
      bufRef.current = await ctx.decodeAudioData(await r.arrayBuffer());
    }
    return bufRef.current;
  }
  async function play(force) {
    if (!force && isMuted()) return;
    try {
      const ctx = audio(); const buf = await sound(); if (!ctx || !buf) return;
      if (ctx.state === 'suspended') await ctx.resume();
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
    } catch { /* no sound available here */ }
  }

  async function check() {
    let after;
    try { after = localStorage.getItem(key); } catch { /* ignore */ }
    if (!after) { try { localStorage.setItem(key, new Date().toISOString()); } catch { /* ignore */ } return; } // first visit: no backlog
    try {
      const r = await fetch(`${apiBaseUrl().replace(/\/$/, '')}/account/new-bookings?after=${encodeURIComponent(after)}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!r.ok) return;
      const d = await r.json();
      try { localStorage.setItem(key, d.now); } catch { /* ignore */ }
      const ours = (d.bookings || []).filter((b) => b.simonStays);
      if (!ours.length) return;
      const last = ours[ours.length - 1];
      setCard({ ...last, count: ours.length, earnCents: ours.reduce((n, b) => n + (b.earnCents || 0), 0) });
      play();
    } catch { /* offline: try again next time */ }
  }

  useEffect(() => {
    if (!hostId) return undefined;
    check();
    const t = setInterval(check, POLL_MS);
    const unlock = () => { const c = audio(); if (c && c.state === 'suspended') c.resume().catch(() => {}); sound().catch(() => {}); };
    const onVis = () => { if (document.visibilityState === 'visible') check(); };
    const onTest = () => { setCard(EXAMPLE); play(true); };
    ['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, unlock, { once: true }));
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('ss:test-booking-sound', onTest);
    return () => {
      clearInterval(t);
      ['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.removeEventListener(e, unlock));
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('ss:test-booking-sound', onTest);
    };
    // eslint-disable-next-line
  }, [hostId]);

  if (!card) return null;
  const close = () => setCard(null);
  return (
    <div className="kaching" role="status" aria-live="polite">
      <div className="kaching-confetti" aria-hidden="true">{Array.from({ length: 16 }, (_, i) => <i key={i} style={{ '--i': i }} />)}</div>
      <button className="kaching-x" onClick={close} aria-label="Close">×</button>
      <div className="kaching-head">💸 Ka-ching!{card.example && <span className="kaching-ex">Example</span>}</div>
      <div className="kaching-sub">{card.count > 1 ? `${card.count} new SimonStays bookings` : 'New SimonStays booking'}</div>
      <div className="kaching-earn"><span>You earn</span><b>{rand(card.earnCents || 0)}</b></div>
      <div className="kaching-what">
        <b>{card.place}</b>
        <span>{card.guestName || 'Guest'} · {day(card.checkIn)} → {day(card.checkOut)} · {card.nights} night{card.nights === 1 ? '' : 's'}</span>
      </div>
      <div className="kaching-btns">
        <button onClick={() => { close(); navigate(card.unitId ? `/calendar/unit/${card.unitId}` : '/calendar'); }}>See it on the calendar</button>
        <button className="secondary" onClick={() => { close(); navigate('/listings'); }}>List another place</button>
      </div>
    </div>
  );
}
