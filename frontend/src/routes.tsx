import { lazy, Suspense } from "react";
import { Navigate, Outlet, useLocation, type RouteObject } from "react-router-dom";
import { Spinner } from "@/components/ui/spinner";
import { AppLayout } from "@/components/AppLayout";
import { useAuthStore } from "@/stores/auth";
import LoginPage from "@/pages/LoginPage";
import DashboardPage from "@/pages/DashboardPage";
import WorkflowsPage from "@/pages/WorkflowsPage";
import ExecutionsPage from "@/pages/ExecutionsPage";
import ApprovalsPage from "@/pages/ApprovalsPage";
import AgentsPage from "@/pages/AgentsPage";
import ModelSettingsPage from "@/pages/ModelSettingsPage";
import NotFoundPage from "@/pages/NotFoundPage";

// The two React Flow pages are code-split.
const WorkflowEditorPage = lazy(() => import("@/pages/WorkflowEditorPage"));
const ExecutionPage = lazy(() => import("@/pages/ExecutionPage"));

function RequireAuth() {
  const token = useAuthStore((s) => s.token);
  const loc = useLocation();
  if (!token) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Outlet />;
}

function Lazy({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner className="size-5" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "workflows", element: <WorkflowsPage /> },
          { path: "workflows/:id/edit", element: <Lazy><WorkflowEditorPage /></Lazy>, handle: { fullBleed: true } },
          { path: "executions", element: <ExecutionsPage /> },
          { path: "executions/:id", element: <Lazy><ExecutionPage /></Lazy>, handle: { fullBleed: true } },
          { path: "approvals", element: <ApprovalsPage /> },
          { path: "agents", element: <AgentsPage /> },
          { path: "settings/models", element: <ModelSettingsPage /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
