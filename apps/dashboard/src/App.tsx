import { Suspense, lazy, type ReactElement } from 'react';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { LayoutShell } from './components/LayoutShell';
import { RouteSkeleton } from './components/RouteSkeleton';

const ChatPage = lazy(() => import('./pages/ChatPage').then((module) => ({ default: module.ChatPage })));
const FocusPage = lazy(() => import('./pages/FocusPage').then((module) => ({ default: module.FocusPage })));
const HistoryPage = lazy(() => import('./pages/HistoryPage').then((module) => ({ default: module.HistoryPage })));

function withRouteSuspense(node: ReactElement) {
  return <Suspense fallback={<RouteSkeleton />}>{node}</Suspense>;
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <LayoutShell />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      { path: 'chat', element: withRouteSuspense(<ChatPage />) },
      { path: 'focus', element: withRouteSuspense(<FocusPage />) },
      { path: 'history', element: withRouteSuspense(<HistoryPage />) },
      { path: '*', element: <Navigate to="/chat" replace /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
