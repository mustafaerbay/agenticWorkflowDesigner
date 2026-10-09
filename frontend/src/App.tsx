import { useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createQueryClient } from "@/lib/queryClient";
import { applyTheme, resolveTheme, useThemeStore } from "@/stores/theme";
import { setUnauthorizedHandler } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { routes } from "./routes";

export function ThemeSync() {
  const theme = useThemeStore((s) => s.theme);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => applyTheme("system");
    mq.addEventListener?.("change", h);
    return () => mq.removeEventListener?.("change", h);
  }, [theme]);
  return null;
}

export function Providers({ children, client }: { children: React.ReactNode; client?: ReturnType<typeof createQueryClient> }) {
  const [qc] = useState(() => client ?? createQueryClient());
  const theme = useThemeStore((s) => s.theme);
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={300}>
        <ThemeSync />
        {children}
        <Toaster richColors closeButton position="bottom-right" theme={resolveTheme(theme)} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const router = createBrowserRouter(routes);

setUnauthorizedHandler(() => {
  useAuthStore.getState().logout();
  const loc = router.state.location;
  if (!loc.pathname.startsWith("/login")) {
    void router.navigate(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true });
  }
});

export default function App() {
  return (
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
}
