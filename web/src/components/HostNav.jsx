import { useEffect, useRef, useState } from 'react';
import { navigate } from '../router.js';
import NotificationsBell from './NotificationsBell.jsx';

// The one bar across every hosting screen: the five sections, alerts, the
// switch to travelling, and the account menu. Each screen keeps its own green
// sub-header underneath for its title and tabs.
const SECTIONS = [
  { key: 'today', label: 'Today', to: '/' },
  { key: 'calendar', label: 'Calendar', to: '/calendar' },
  { key: 'listings', label: 'Listings', to: '/listings' },
  { key: 'inbox', label: 'Inbox', to: '/inbox' },
  { key: 'menu', label: 'Menu', to: '/menu' },
];

export default function HostNav({ section, host, inboxCount = 0, onSwitchToTravelling, switching, onLogout, onOpenReport, onOpenMessage }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const initials = (host?.name || host?.email || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  return (
    <nav className="hostnav" aria-label="Hosting">
      <button className="hostnav-brand" onClick={() => navigate('/')} title="Today">Simon<span>Stays</span></button>
      <div className="hostnav-sections">
        {SECTIONS.map((s) => (
          <button key={s.key} className={section === s.key ? 'on' : ''} aria-current={section === s.key ? 'page' : undefined} onClick={() => navigate(s.to)}>
            {s.label}{s.key === 'inbox' && inboxCount > 0 && <span className="msg-dot">{inboxCount}</span>}
          </button>
        ))}
      </div>
      <div className="hostnav-right">
        <NotificationsBell onOpen={onOpenReport} onOpenMessage={onOpenMessage} />
        <button className="hostnav-switch" onClick={onSwitchToTravelling} disabled={switching}>{switching ? 'Switching…' : 'Switch to travelling'}</button>
        <div className="hostnav-acct" ref={ref}>
          <button className="hostnav-avatar" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={host?.email}>{initials}</button>
          {open && (
            <div className="hostnav-menu" role="menu">
              <div className="hostnav-who"><b>{host?.name || 'Your account'}</b><span>{host?.email}</span></div>
              <button role="menuitem" onClick={() => { setOpen(false); navigate('/settings'); }}>Settings</button>
              <button role="menuitem" onClick={() => { setOpen(false); onSwitchToTravelling(); }}>Switch to travelling</button>
              {host?.isAdmin && <button role="menuitem" onClick={() => { setOpen(false); navigate('/admin'); }}>Platform admin</button>}
              <button role="menuitem" onClick={() => { setOpen(false); onLogout(); }}>Log out</button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
