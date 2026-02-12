import { NavLink, Outlet } from 'react-router-dom';
import { LocalNetworkBanner } from './LocalNetworkBanner';

const navItems = [
  { to: '/', label: 'Ops cockpit' },
  { to: '/runs', label: 'Runs' },
  { to: '/queue', label: 'Queue' },
  { to: '/audit', label: 'Audit' },
  { to: '/persona', label: 'Persona' },
  { to: '/policy', label: 'Policy' },
  { to: '/memory', label: 'Memory' },
  { to: '/retrieval', label: 'Retrieval' },
  { to: '/wrela-learning', label: 'Wrela Learning' },
  { to: '/token-economy', label: 'Token Economy' },
  { to: '/system', label: 'System' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/tests-evolution', label: 'Tests Evolution' },
  { to: '/memos', label: 'CTO Memos' },
  { to: '/graph', label: 'Arch Graph' },
  { to: '/perf-scientist', label: 'Perf Scientist' },
  { to: '/perf-scientist/experiments', label: 'Perf Experiments' },
  { to: '/perf-scientist/candidates', label: 'Perf Candidates' },
  { to: '/perf-scientist/leaderboard', label: 'Perf Leaderboard' },
];

export function LayoutShell() {
  return (
    <div className="layout-shell">
      <header className="topbar">
        <div>
          <h1>Ops Dashboard</h1>
          <p className="muted">Realtime control surface for autonomous operations</p>
        </div>
        <LocalNetworkBanner />
      </header>

      <nav className="tabs" aria-label="Main navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => (isActive ? 'tab active' : 'tab')}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="page-content">
        <Outlet />
      </main>
    </div>
  );
}
