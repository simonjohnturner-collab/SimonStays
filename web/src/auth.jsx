import { createContext, useContext, useEffect, useState } from 'react';
import { api, setToken, getToken } from './api.js';

const AuthCtx = createContext(null);
const ADMIN_TOKEN_KEY = 'staysync_admin_token'; // the admin's own token, stashed while impersonating

export function AuthProvider({ children }) {
  const [host, setHost] = useState(null);
  const [loading, setLoading] = useState(true);
  // We're impersonating iff the admin's own token is stashed away.
  const [impersonating, setImpersonating] = useState(() => !!localStorage.getItem(ADMIN_TOKEN_KEY));

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    api.me()
      .then((r) => setHost(r.host))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password) {
    const r = await api.login(email, password);
    setToken(r.token); setHost(r.host);
  }
  async function register(email, password, name) {
    const r = await api.register(email, password, name);
    setToken(r.token); setHost(r.host);
  }
  function logout() {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    setToken(null); setHost(null);
  }

  // Admin: sign in as another host. Stash our own token so we can come back,
  // switch to the host's token, then reload so every view refetches as them.
  async function impersonate(hostId) {
    const mine = getToken();
    const r = await api.adminImpersonate(hostId);
    if (mine) localStorage.setItem(ADMIN_TOKEN_KEY, mine);
    setToken(r.token);
    window.location.reload();
  }
  function stopImpersonating() {
    const mine = localStorage.getItem(ADMIN_TOKEN_KEY);
    if (mine) setToken(mine);
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    window.location.reload();
  }

  return (
    <AuthCtx.Provider value={{ host, loading, login, register, logout, impersonating, impersonate, stopImpersonating }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
