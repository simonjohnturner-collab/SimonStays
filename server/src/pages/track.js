// SimonStays first-party analytics: what visitors look at and do, stored in our
// own database (POST /public/track). No cookies, no third parties, no IP kept.
// A visitor is an anonymous random id in localStorage; a session ends after 30
// minutes of no activity. Bots are skipped. Hosts browsing the site (signed in to
// hosting on this browser) are flagged so the admin can leave them out.
// Usage from the page: window.ssTrack(type, { label, unitId, propertyId, meta })
(function () {
  var noop = function () {};
  if (/bot|crawl|spider|slurp|headless|lighthouse|pingdom|preview|facebookexternalhit|whatsapp|telegram/i.test(navigator.userAgent || '')) { window.ssTrack = noop; return; }
  var rid = function () { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); };
  var vid;
  try { vid = localStorage.getItem('ss_vid'); if (!vid) { vid = rid(); localStorage.setItem('ss_vid', vid); } } catch (e) { vid = rid(); }
  function sessionId() {
    try {
      var s = JSON.parse(sessionStorage.getItem('ss_sid') || 'null'), now = Date.now();
      if (!s || now - s.t > 30 * 60 * 1000) s = { id: rid(), t: now, src: source() };
      s.t = now; sessionStorage.setItem('ss_sid', JSON.stringify(s));
      return s;
    } catch (e) { return { id: vid, src: '' }; }
  }
  function source() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('utm_source')) return q.get('utm_source').slice(0, 60);
      if (document.referrer) { var h = new URL(document.referrer).hostname.replace(/^www\./, ''); if (h && h !== location.hostname.replace(/^www\./, '')) return h; }
    } catch (e) { /* ignore */ }
    return '';
  }
  var ua = navigator.userAgent || '';
  var device = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
  var isHost = function () { try { return !!localStorage.getItem('staysync_token'); } catch (e) { return false; } };
  var queue = [], timer = null;
  function flush() {
    if (!queue.length) return;
    var s = sessionId();
    var body = JSON.stringify({ v: vid, s: s.id, src: s.src || '', d: device, h: isHost(), events: queue.splice(0, 25) });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/public/track', new Blob([body], { type: 'application/json' }))) return;
    } catch (e) { /* fall through */ }
    try { fetch('/public/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }); } catch (e) { /* ignore */ }
  }
  window.ssTrack = function (type, data) {
    data = data || {};
    queue.push({ t: type, p: location.pathname, l: data.label != null ? String(data.label).slice(0, 120) : null, u: data.unitId || null, pr: data.propertyId || null, m: data.meta || null });
    clearTimeout(timer); timer = setTimeout(flush, 1500);
    if (queue.length >= 20) flush();
  };
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
  // Every click on a link or button: its data-track name, id, or visible text.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-track],a,button') : null;
    if (!el) return;
    var label = el.getAttribute('data-track') || (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) || el.id || el.getAttribute('aria-label');
    if (label) window.ssTrack('click', { label: label });
  }, true);
  window.ssTrack('pageview');
})();
