import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Hosting has moved to simonstays.co.za/hosting. The old static site
// (simonstays.onrender.com) checks the new home is live, then sends the host
// there, carrying their sign-in once in the URL fragment so they stay signed in.
const NEW_HOME = 'https://simonstays.co.za';
async function movedToNewHome() {
  if (!window.location.hostname.endsWith('.onrender.com')) return false;
  try {
    const r = await fetch(`${NEW_HOME}/hosting-ready`, { cache: 'no-store' });
    if (!r.ok || !(await r.json()).ready) return false;
  } catch { return false; }
  let token = null;
  try { token = localStorage.getItem('staysync_token'); } catch { /* ignore */ }
  window.location.replace(`${NEW_HOME}/hosting/${token ? `#t=${encodeURIComponent(token)}` : ''}`);
  return true;
}

movedToNewHome().then((moved) => {
  if (moved) return;
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
