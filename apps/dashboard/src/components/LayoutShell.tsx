import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Button } from './ui/button';
import { cn } from '../lib/cn';
import { appIcons } from '../lib/icons';

const navItems = [
  { to: '/chat', label: 'Chat', icon: appIcons.chat },
  { to: '/focus', label: 'Focus', icon: appIcons.focus },
  { to: '/history', label: 'History', icon: appIcons.history },
];

const routePreloaders: Record<string, () => Promise<unknown>> = {
  '/chat': () => import('../pages/ChatPage'),
  '/focus': () => import('../pages/FocusPage'),
  '/history': () => import('../pages/HistoryPage'),
};

function prefetchRoute(path: string) {
  void routePreloaders[path]?.();
}

const mobileQuickNavItems = navItems;

type Density = 'comfortable' | 'compact';

function Navigation({ onSelect }: { onSelect?: () => void }) {
  return (
    <nav className="minimal-nav" aria-label="Main navigation">
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end
          className={({ isActive }) => cn('tab', isActive && 'active')}
          onMouseEnter={() => prefetchRoute(item.to)}
          onFocus={() => prefetchRoute(item.to)}
          onClick={onSelect}
        >
          <span className="nav-item-label">
            <item.icon className="icon icon-16" aria-hidden="true" />
            <span>{item.label}</span>
          </span>
        </NavLink>
      ))}
    </nav>
  );
}

export function LayoutShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [density] = useState<Density>(() => {
    if (typeof window === 'undefined') {
      return 'comfortable';
    }
    return window.localStorage.getItem('dashboard_density') === 'compact' ? 'compact' : 'comfortable';
  });
  const location = useLocation();
  const currentTitle = useMemo(() => navItems.find((item) => item.to === location.pathname)?.label ?? 'Dashboard', [location.pathname]);
  useEffect(() => {
    window.localStorage.setItem('dashboard_density', density);
  }, [density]);

  return (
    <div className={cn('layout-shell app-shell', density === 'compact' && 'density-compact')}>
      <header className="topbar app-header minimal-header">
        <div className="brand-wrap">
          <div className="brand-row">
            <h1>Squidward</h1>
          </div>
          <p className="muted">Operator console</p>
        </div>
        <div className="topbar-actions minimal-topbar-actions">
          <Navigation />
          <Button
            aria-expanded={mobileNavOpen}
            aria-label="Toggle navigation menu"
            className="mobile-nav-toggle"
            onClick={() => setMobileNavOpen((value) => !value)}
            type="button"
            variant="outline"
          >
            {mobileNavOpen ? 'Close' : 'Menu'}
          </Button>
        </div>
      </header>

      <main className="page-content app-main minimal-main">
        <div className="page-header-mobile">
          <h2>{currentTitle}</h2>
        </div>
        <Outlet />
      </main>

      <div className={cn('mobile-sheet-backdrop', mobileNavOpen && 'open')} onClick={() => setMobileNavOpen(false)} aria-hidden="true" />
      <aside className={cn('mobile-sheet', mobileNavOpen && 'open')} aria-label="Mobile navigation">
        <div className="mobile-sheet-header">
          <h2>Navigation</h2>
          <Button onClick={() => setMobileNavOpen(false)} type="button" variant="ghost" size="sm">
            Dismiss
          </Button>
        </div>
        <Navigation onSelect={() => setMobileNavOpen(false)} />
      </aside>

      <nav className="mobile-bottom-nav" aria-label="Mobile quick navigation">
        {mobileQuickNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => cn('mobile-bottom-nav__item', isActive && 'active')}
            onMouseEnter={() => prefetchRoute(item.to)}
            onFocus={() => prefetchRoute(item.to)}
          >
            <span className="mobile-bottom-nav__content">
              <item.icon className="icon icon-16" aria-hidden="true" />
              <span>{item.label}</span>
            </span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
