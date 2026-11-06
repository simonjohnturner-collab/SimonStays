import { navigate } from '../router.js';

// Hosting › Menu: everything that isn't Today, Calendar, Listings or Inbox,
// grouped the way a host thinks about it. Replaces the old 16-item ☰ list.
export default function MenuView({ isAdmin, onPropertiesAndUnits, onFindBooking, onSwitchToTravelling, onLogout }) {
  const groups = [
    { title: 'Run the place', items: [
      { icon: '📋', label: 'Reports', hint: 'Cleans, repairs, damage and purchases', to: '/reports' },
      { icon: '🧰', label: 'Team', hint: 'Cleaners, contractors and what they earn per clean', to: '/team' },
      { icon: '📇', label: 'Guests', hint: 'Your guest contact book', to: '/guests' },
    ] },
    { title: 'Bookings', items: [
      { icon: '📅', label: 'Find or add a booking', hint: 'Search every booking, or add one', run: onFindBooking },
      { icon: '🏠', label: 'Properties & units', hint: 'Add, rename and order properties; pricing groups', run: onPropertiesAndUnits },
    ] },
    { title: 'Listings', items: [
      { icon: '🖼️', label: 'Listings', hint: 'Descriptions, photos, map pin, policies', to: '/listings' },
      { icon: '💲', label: 'Pricing', hint: 'Rate cards and pricing groups', to: '/listings/pricing' },
      { icon: '📁', label: 'House documents', hint: 'Files guests get before they arrive', to: '/listings/documents' },
      { icon: '🔒', label: 'Smart locks', hint: 'Locks and guest access codes', to: '/listings/locks' },
    ] },
    { title: 'Money', items: [
      { icon: '💰', label: 'Payouts', hint: 'SimonStays bookings, fees and what you’re paid', to: '/money' },
      { icon: '🧾', label: 'Invoices', hint: 'Invoices you send guests', to: '/money/invoices' },
      { icon: '🏢', label: 'Billing details', hint: 'Company and bank details on your invoices', to: '/money/billing' },
    ] },
    { title: 'Insights', items: [
      { icon: '📈', label: 'Market watch', hint: 'How full the competition is', to: '/insights' },
    ] },
    { title: 'You', items: [
      { icon: '👤', label: 'Settings', hint: 'Your details and payout bank account', to: '/settings' },
      { icon: '🧳', label: 'Switch to travelling', hint: 'Book a stay, see your trips', run: onSwitchToTravelling },
      ...(isAdmin ? [{ icon: '🛡️', label: 'Platform admin', hint: 'All hosts, guests, transactions and refunds', to: '/admin' }] : []),
      { icon: '↩', label: 'Log out', hint: 'Signs you out of hosting and travelling', run: onLogout },
    ] },
  ];
  return (
    <div className="menu-page">
      {groups.map((g) => (
        <section key={g.title} className="menu-group">
          <h2>{g.title}</h2>
          <div className="menu-grid">
            {g.items.map((it) => (
              <button key={it.label} className="menu-card" onClick={() => (it.run ? it.run() : navigate(it.to))}>
                <span className="menu-ic" aria-hidden="true">{it.icon}</span>
                <span className="menu-txt"><b>{it.label}</b><span>{it.hint}</span></span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
