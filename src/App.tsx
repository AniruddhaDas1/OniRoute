import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';

// Auth pages stay eager: they are the entry point, and deferring them would add
// a round trip before first paint. The dashboard pages behind the auth gate are
// split out, so signing in no longer costs a single bundle containing all of them.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ProvidersPage = lazy(() => import('./pages/ProvidersPage'));
const RoutingPage = lazy(() => import('./pages/RoutingPage'));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage'));
const PlaygroundPage = lazy(() => import('./pages/PlaygroundPage'));
const LogsPage = lazy(() => import('./pages/LogsPage'));
const AdminMembersPage = lazy(() => import('./pages/AdminMembersPage'));

function PageFallback() {
  return (
    <div className="flex items-center justify-center py-20 text-gray-400">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />

        <Route element={<ProtectedRoute />}>
          {/* Suspense sits inside Layout's route so the chrome stays put while a
              page chunk loads, rather than blanking the whole screen. */}
          <Route path="/dashboard" element={<Layout />}>
            <Route index element={<Suspense fallback={<PageFallback />}><DashboardPage /></Suspense>} />
            <Route path="providers" element={<Suspense fallback={<PageFallback />}><ProvidersPage /></Suspense>} />
            <Route path="routing" element={<Suspense fallback={<PageFallback />}><RoutingPage /></Suspense>} />
            <Route path="knowledge" element={<Suspense fallback={<PageFallback />}><KnowledgePage /></Suspense>} />
            <Route path="playground" element={<Suspense fallback={<PageFallback />}><PlaygroundPage /></Suspense>} />
            <Route path="logs" element={<Suspense fallback={<PageFallback />}><LogsPage /></Suspense>} />
            <Route path="members" element={<Suspense fallback={<PageFallback />}><AdminMembersPage /></Suspense>} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
