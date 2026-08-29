import { createContext, useContext, useEffect, useState } from 'react';
import { api, setToken, getToken } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [host, setHost] = useState(null);
  const [loading, setLoading] = useState(true);

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
  function logout() { setToken(null); setHost(null); }

  return (
    <AuthCtx.Provider value={{ host, loading, login, register, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
