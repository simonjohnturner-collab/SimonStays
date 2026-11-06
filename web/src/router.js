// Tiny path router for the hosting app. Every screen has its own address so a
// refresh, a bookmark or a shared link lands on the same screen.
//
// The app is served at simonstays.co.za/hosting (by the API server) and, during
// the move, still at the old static site's root. BASE is whichever prefix this
// copy runs under; routes inside the app are written without it ("/calendar").
import { useEffect, useState } from 'react';

export const BASE = window.location.pathname.startsWith('/hosting') ? '/hosting' : '';

export function currentPath() {
  const p = window.location.pathname.slice(BASE.length) || '/';
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

// Go to an in-app path ("/reports/abc?x=1"). `replace` swaps the history entry.
export function navigate(to, { replace = false } = {}) {
  const url = BASE + (to.startsWith('/') ? to : '/' + to);
  if (url === window.location.pathname + window.location.search) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
  window.dispatchEvent(new Event('ss:navigate'));
  window.scrollTo(0, 0);
}

// The current in-app path and query, re-rendering on back/forward and navigate().
export function useRoute() {
  const read = () => ({ path: currentPath(), query: new URLSearchParams(window.location.search) });
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('popstate', on);
    window.addEventListener('ss:navigate', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('ss:navigate', on); };
  }, []);
  return route;
}

// Match "/reports/:id" style patterns. Returns params or null.
export function match(pattern, path) {
  const a = pattern.split('/').filter(Boolean), b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

// Where "Switch to travelling" goes: the guest site on the same domain when
// served from /hosting, otherwise the live guest site.
export const GUEST_SITE = BASE ? window.location.origin : 'https://simonstays.co.za';
