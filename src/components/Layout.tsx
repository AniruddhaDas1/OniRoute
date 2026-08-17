import { useState, ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { cn } from '../lib/utils';
import {
  LayoutDashboard,
  Server,
  Route,
  BookOpen,
  MessageSquare,
  FileText,
  LogOut,
  Menu,
  X,
  Users,
  Crown,
} from 'lucide-react';

const baseNavItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/dashboard/providers', label: 'Providers', icon: Server, end: false },
  { to: '/dashboard/routing', label: 'Routing', icon: Route, end: false },
  { to: '/dashboard/knowledge', label: 'Knowledge Base', icon: BookOpen, end: false },
  { to: '/dashboard/playground', label: 'Playground', icon: MessageSquare, end: false },
  { to: '/dashboard/logs', label: 'Logs', icon: FileText, end: false },
];

interface LayoutProps {
  children?: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const { user, signOut, isSuperAdmin } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navItems = isSuperAdmin
    ? [
        ...baseNavItems,
        {
          to: '/dashboard/members',
          label: 'Team & Members',
          icon: Users,
          end: false,
          adminBadge: true,
        },
      ]
    : baseNavItems;

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 w-64 bg-gray-900 flex flex-col transition-transform duration-200 ease-in-out',
          'lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Logo */}
        <div className="flex items-center justify-between h-16 px-6 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-white tracking-tight">OniRoute</span>
            {isSuperAdmin && (
              <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                <Crown className="h-2.5 w-2.5" /> Admin
              </span>
            )}
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="text-gray-400 hover:text-white lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const { to, label, icon: Icon, end } = item;
            const hasAdminBadge = 'adminBadge' in item && item.adminBadge;

            return (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-gray-800 text-white'
                      : 'text-gray-400 hover:bg-gray-800/60 hover:text-gray-100'
                  )
                }
              >
                <div className="flex items-center gap-3">
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span>{label}</span>
                </div>
                {hasAdminBadge && (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                    Control
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* User section */}
        <div className="border-t border-gray-800 px-4 py-4">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-gray-400 font-medium truncate">{user?.email}</p>
            {isSuperAdmin && (
              <span title="Super Admin">
                <Crown className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              </span>
            )}
          </div>
          <button
            onClick={signOut}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mt-2"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top bar */}
        <header className="flex items-center justify-between h-16 px-6 bg-white border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="text-gray-600 hover:text-gray-900 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="text-base font-semibold text-gray-900">OniRoute Dashboard</h1>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2">
              <span className="text-sm text-gray-600">{user?.email}</span>
              {isSuperAdmin && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 border border-amber-200">
                  <Crown className="h-3 w-3 text-amber-600" /> Super Admin
                </span>
              )}
            </div>
            <button
              onClick={signOut}
              className="hidden sm:flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6">
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  );
}
