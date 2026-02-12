import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { LayoutShell } from './components/LayoutShell';
import { AuditPage } from './pages/AuditPage';
import { CockpitPage } from './pages/CockpitPage';
import { GraphPage } from './pages/GraphPage';
import { MemosPage } from './pages/MemosPage';
import { PerfScientistCandidatesPage } from './pages/PerfScientistCandidatesPage';
import { PerfScientistExperimentsPage } from './pages/PerfScientistExperimentsPage';
import { PerfScientistLeaderboardPage } from './pages/PerfScientistLeaderboardPage';
import { PerfScientistOverviewPage } from './pages/PerfScientistOverviewPage';
import { PersonaPage } from './pages/PersonaPage';
import { PolicyPage } from './pages/PolicyPage';
import { PortfolioPage } from './pages/PortfolioPage';
import { QueuePage } from './pages/QueuePage';
import { RunsPage } from './pages/RunsPage';
import { SystemPage } from './pages/SystemPage';
import { TestsEvolutionPage } from './pages/TestsEvolutionPage';
import { MemoryPage } from './pages/MemoryPage';
import { RetrievalPage } from './pages/RetrievalPage';
import { WrelaLearningPage } from './pages/WrelaLearningPage';
import { TokenEconomyPage } from './pages/TokenEconomyPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <LayoutShell />,
    children: [
      { index: true, element: <CockpitPage /> },
      { path: 'runs', element: <RunsPage /> },
      { path: 'queue', element: <QueuePage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'persona', element: <PersonaPage /> },
      { path: 'policy', element: <PolicyPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'retrieval', element: <RetrievalPage /> },
      { path: 'wrela-learning', element: <WrelaLearningPage /> },
      { path: 'token-economy', element: <TokenEconomyPage /> },
      { path: 'system', element: <SystemPage /> },
      { path: 'portfolio', element: <PortfolioPage /> },
      { path: 'tests-evolution', element: <TestsEvolutionPage /> },
      { path: 'memos', element: <MemosPage /> },
      { path: 'graph', element: <GraphPage /> },
      { path: 'perf-scientist', element: <PerfScientistOverviewPage /> },
      { path: 'perf-scientist/experiments', element: <PerfScientistExperimentsPage /> },
      { path: 'perf-scientist/candidates', element: <PerfScientistCandidatesPage /> },
      { path: 'perf-scientist/leaderboard', element: <PerfScientistLeaderboardPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
