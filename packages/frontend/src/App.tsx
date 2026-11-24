import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy } from "react";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ErrorBoundary } from "./components/ui/error-boundary";

const HomePage = lazy(() => import("./pages/HomePage"));
const ProjectPage = lazy(() => import("./pages/ProjectPage"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const NewProjectPage = lazy(() => import("./pages/NewProjectPage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

function LoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <span className="loading loading-spinner loading-lg" />
      <span className="ml-3 text-muted-foreground">加载中...</span>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <BrowserRouter>
          <Suspense fallback={<LoadingFallback />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/project/new" element={<NewProjectPage />} />
              <Route path="/project/:id" element={<ProjectPage />} />
              <Route path="/projects/:id" element={<ProjectPage />} />
              {/* IP 宇宙整体下线：后端无 universes 接口与表，见 MODIFICATIONS.md */}
              <Route path="/universes" element={<Navigate to="/projects" replace />} />
              <Route path="/universes/*" element={<Navigate to="/projects" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
          <SettingsDialog />
        </BrowserRouter>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
