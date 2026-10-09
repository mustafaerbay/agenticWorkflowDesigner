import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { LogIn, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ThemeToggle } from "@/components/ThemeToggle";
import { api, errorMessage } from "@/services/api";
import { useAuthStore } from "@/stores/auth";

function safeNext(next: string | null): string {
  // only allow same-origin relative paths
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const setSession = useAuthStore((s) => s.setSession);
  const next = safeNext(params.get("next"));

  const login = useMutation({
    mutationFn: () => api.login(email.trim(), password),
    onSuccess: (r) => {
      setSession(r.access_token, r.user);
      navigate(next, { replace: true });
    },
  });

  if (token && !login.isPending) return <Navigate to={next} replace />;

  return (
    <div className="relative flex min-h-full items-center justify-center bg-background p-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-40 left-1/2 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl" />
      </div>
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
            <Workflow className="size-5" aria-hidden />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Sign in to Agentic SDLC</h1>
          <p className="mt-1 text-sm text-muted-foreground">Design, run and monitor AI agent workflows.</p>
        </div>
        <form
          className="space-y-4 rounded-xl border bg-card p-6 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {login.isError && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {errorMessage(login.error)}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? <Spinner className="text-primary-foreground" /> : <LogIn />} Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
