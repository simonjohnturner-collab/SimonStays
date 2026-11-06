import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { GUEST_SITE } from '../router.js';

// The guest session from the travelling side (same domain when served at /hosting).
function readGuest() {
  try { const s = JSON.parse(localStorage.getItem('ss_guest') || 'null'); return s && s.token ? s : null; } catch { return null; }
}

export default function Login() {
  const { login, register, adopt } = useAuth();
  const guest = readGuest();
  // "Switch to hosting" / "Become a host" lands here with ?signup — start on register.
  const [mode, setMode] = useState(() => (/[?&]signup\b/.test(window.location.search) ? 'register' : 'login'));
  const [email, setEmail] = useState(guest?.account?.email || '');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(guest?.account?.name || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name);
    } catch (ex) {
      setErr(prettyError(ex));
    } finally { setBusy(false); }
  }

  // One account: a signed-in traveller opens hosting with the same login.
  async function startHosting() {
    setErr(''); setBusy(true);
    try {
      const r = await api.becomeHost(guest.token);
      adopt(r.token);
    } catch (ex) {
      if (ex.message === 'host_exists') { setMode('login'); setEmail(guest.account?.email || ''); }
      setErr((ex.data && ex.data.message) || prettyError(ex));
    } finally { setBusy(false); }
  }

  return (
    <div className="center">
      <div className="card auth">
        <div className="brand">Simon<span>Stays</span></div>
        <p className="muted small">Hosting: your calendar, listings, guests and payouts in one place.</p>

        {guest && (
          <div className="auth-guest">
            <p>You’re signed in to SimonStays as <b>{guest.account?.email}</b>.</p>
            <button type="button" disabled={busy} onClick={startHosting}>{busy ? '…' : 'Start hosting with this account'}</button>
            <p className="muted small">Already host with a different password? Sign in below.</p>
          </div>
        )}

        <form onSubmit={submit} className="auth-form">
          {mode === 'register' && (
            <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          )}
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input type="password" placeholder="Password (min 8 chars)" value={password} onChange={(e) => setPassword(e.target.value)} required />

          {err && <div className="error">{err}</div>}
          <button disabled={busy} type="submit" className={guest ? 'secondary' : ''}>{busy ? '…' : mode === 'login' ? 'Log in' : 'Create hosting account'}</button>
        </form>

        <div className="muted small switch">
          {mode === 'login'
            ? <>New to hosting? <a onClick={() => setMode('register')}>Create an account</a></>
            : <>Have an account? <a onClick={() => setMode('login')}>Log in</a></>}
        </div>
        <div className="muted small switch"><a href={GUEST_SITE + '/'}>← Back to travelling</a></div>
      </div>
    </div>
  );
}

function prettyError(ex) {
  const map = {
    invalid_credentials: 'Wrong email or password.',
    email_taken: 'That email is already registered.',
    password_too_short: 'Password must be at least 8 characters.',
    email_and_password_required: 'Email and password are required.',
    email_unverified: 'Please confirm your email first. Check your inbox for our link.',
    host_exists: 'You already have a hosting account. Sign in with your hosting password.',
  };
  return map[ex.message] || ex.message || 'Something went wrong.';
}
