import { AuthProvider, useAuth } from './auth.jsx';
import Login from './components/Login.jsx';
import Main from './components/Main.jsx';

function Gate() {
  const { host, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  return host ? <Main /> : <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
