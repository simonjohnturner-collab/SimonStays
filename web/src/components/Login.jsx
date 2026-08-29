import { useState } from 'react';
import { useAuth } from '../auth.jsx';

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
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

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <div className="brand">Simon<span>Stays</span></div>
        <p className="muted small">Property calendars, synced across channels.</p>

        {mode === 'register' && (
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password (min 8 chars)" value={password} onChange={(e) => setPassword(e.target.value)} required />

        {err && <div className="error">{err}</div>}
        <button disabled={busy} type="submit">{busy ? '…' : mode === 'login' ? 'Log in' : 'Create account'}</button>

        <div className="muted small switch">
          {mode === 'login'
            ? <>New here? <a onClick={() => setMode('register')}>Create an account</a></>
            : <>Have an account? <a onClick={() => setMode('login')}>Log in</a></>}
        </div>
      </form>
    </div>
  );
}

function prettyError(ex) {
  const map = {
    invalid_credentials: 'Wrong email or password.',
    email_taken: 'That email is already registered.',
    password_too_short: 'Password must be at least 8 characters.',
    email_and_password_required: 'Email and password are required.',
  };
  return map[ex.message] || ex.message || 'Something went wrong.';
}
