/**
 * End-to-end smoke test — no real channel URLs needed.
 * Boots the app on an ephemeral port and drives the full host flow over HTTP:
 * register → property → unit → manual booking → conflict is refused → feed
 * exports the booking → the exported .ics parses back to the same dates.
 */
require('dotenv').config();
const app = require('../src/index');
const { parseFeed } = require('../src/utils/ical');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;
  const J = (t) => ({ 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) });

  try {
    const email = `host_${Date.now()}@example.com`;

    let r = await fetch(`${base}/health`); let j = await r.json();
    check('health ok', r.status === 200 && j.ok);

    r = await fetch(`${base}/auth/register`, { method: 'POST', headers: J(), body: JSON.stringify({ email, password: 'password123', name: 'Test Host' }) });
    j = await r.json();
    const token = j.token;
    check('register returns token', r.status === 201 && !!token);

    r = await fetch(`${base}/auth/me`, { headers: J(token) }); j = await r.json();
    check('me returns host', j.host && j.host.email === email);

    r = await fetch(`${base}/auth/me`); // no token
    check('me without token is 401', r.status === 401);

    r = await fetch(`${base}/properties`, { method: 'POST', headers: J(token), body: JSON.stringify({ name: 'Firenza', address: 'Sandton' }) });
    j = await r.json(); const propertyId = j.property.id;
    check('create property', r.status === 201 && !!propertyId);

    r = await fetch(`${base}/units`, { method: 'POST', headers: J(token), body: JSON.stringify({ propertyId, name: '23', capacity: 4 }) });
    j = await r.json(); const unitId = j.unit.id;
    check('create unit', r.status === 201 && !!unitId);

    // Isolation: a second host cannot touch the first host's unit.
    const email2 = `host2_${Date.now()}@example.com`;
    r = await fetch(`${base}/auth/register`, { method: 'POST', headers: J(), body: JSON.stringify({ email: email2, password: 'password123' }) });
    const token2 = (await r.json()).token;
    r = await fetch(`${base}/units/${unitId}`, { headers: J(token2) });
    check('cross-tenant unit access forbidden', r.status === 403);

    // Manual booking 21→24.
    r = await fetch(`${base}/units/${unitId}/bookings`, { method: 'POST', headers: J(token), body: JSON.stringify({ guestName: 'Kevin', checkIn: '2026-09-21', checkOut: '2026-09-24', paid: true, cleaner: 'Grace' }) });
    j = await r.json(); const bookingId = j.booking.id;
    check('create manual booking', r.status === 201 && !!bookingId);

    // Overlapping booking 23→26 must be refused.
    r = await fetch(`${base}/units/${unitId}/bookings`, { method: 'POST', headers: J(token), body: JSON.stringify({ guestName: 'Clash', checkIn: '2026-09-23', checkOut: '2026-09-26' }) });
    j = await r.json();
    check('overlapping booking refused (409)', r.status === 409 && j.error === 'dates_unavailable' && j.conflicts.length === 1);

    // Back-to-back 24→26 is allowed.
    r = await fetch(`${base}/units/${unitId}/bookings`, { method: 'POST', headers: J(token), body: JSON.stringify({ guestName: 'Hendrik', checkIn: '2026-09-24', checkOut: '2026-09-26' }) });
    check('back-to-back booking allowed', r.status === 201);

    // Feed export (need token). Rewrite the PUBLIC_BASE_URL origin to the test port.
    r = await fetch(`${base}/units/${unitId}`, { headers: J(token) });
    const feedUrl = (await r.json()).unit.feedUrl;
    check('unit exposes feedUrl', /\/feed\/.+\.ics\?token=/.test(feedUrl));
    const feedLocal = base + feedUrl.replace(/^https?:\/\/[^/]+/, '');

    r = await fetch(feedLocal);
    const ics = await r.text();
    check('feed served as calendar', r.status === 200 && /BEGIN:VCALENDAR/.test(ics));
    const events = parseFeed(ics);
    check('feed contains 2 confirmed events', events.length === 2);
    const kevin = events.find((e) => e.start.toISOString().slice(0, 10) === '2026-09-21');
    check('feed event dates round-trip (21→24)', kevin && kevin.end.toISOString().slice(0, 10) === '2026-09-24');

    // Bad token is rejected.
    r = await fetch(feedLocal.replace(/token=.*/, 'token=wrong'));
    check('feed rejects bad token (403)', r.status === 403);

    // Availability endpoint (no channels → just DB check).
    r = await fetch(`${base}/units/${unitId}/availability?checkIn=2026-09-22&checkOut=2026-09-23`, { headers: J(token) });
    j = await r.json();
    check('availability flags a clash', j.available === false && j.conflicts.length >= 1);

    // --- Channel IMPORT: point a 2nd unit's channel at unit 1's live feed and sync. ---
    r = await fetch(`${base}/units`, { method: 'POST', headers: J(token), body: JSON.stringify({ propertyId, name: '24' }) });
    const unit2Id = (await r.json()).unit.id;
    r = await fetch(`${base}/units/${unit2Id}/channels`, { method: 'POST', headers: J(token), body: JSON.stringify({ type: 'airbnb', importUrl: feedLocal, label: 'Airbnb (test)' }) });
    check('add channel connection', r.status === 201);

    r = await fetch(`${base}/units/${unit2Id}/sync`, { method: 'POST', headers: J(token) });
    j = await r.json();
    check('sync imports from channel feed', r.status === 200 && j.summary.added === 2);

    r = await fetch(`${base}/units/${unit2Id}/bookings`, { headers: J(token) });
    const imported = (await r.json()).bookings;
    check('imported bookings present (2)', imported.length === 2);
    check('imported booking is airbnb-sourced + placeholder name', imported.some((b) => b.source === 'airbnb' && (b.guestName === 'Airbnb' || b.guestName === 'Blocked')));
    check('imported dates preserved (21→24)', imported.some((b) => b.checkIn.slice(0, 10) === '2026-09-21' && b.checkOut.slice(0, 10) === '2026-09-24'));

    // Re-sync is idempotent (no duplicates).
    r = await fetch(`${base}/units/${unit2Id}/sync`, { method: 'POST', headers: J(token) });
    j = await r.json();
    check('re-sync is idempotent (0 added)', j.summary.added === 0 && j.summary.updated === 2);
    r = await fetch(`${base}/units/${unit2Id}/bookings`, { headers: J(token) });
    check('still 2 bookings after re-sync', (await r.json()).bookings.length === 2);
  } catch (e) {
    fail++; console.log('  ✗ threw:', e.message); console.error(e);
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
