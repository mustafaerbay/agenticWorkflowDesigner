import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router-dom";
import { vi } from "vitest";
import { Providers } from "@/App";
import { createQueryClient } from "@/lib/queryClient";
import type { User } from "@/types";

export interface Call {
  method: string;
  path: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
  rawBody: unknown;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

type Handler = (call: Call) => Response | Promise<Response> | undefined;

/** Stub fetch with a route handler; records every call. Unhandled requests return 404. */
export function mockFetch(handler: Handler): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const raw = init?.body;
      let body: unknown = raw;
      if (typeof raw === "string") {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const call: Call = { method, url, path: url.split("?")[0]!, body, rawBody: raw, headers: (init?.headers ?? {}) as Record<string, string> };
      calls.push(call);
      const res = await handler(call);
      return res ?? json({ detail: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return calls;
}

export const adminUser: User = {
  id: "u-admin",
  email: "admin@example.com",
  name: "Admin",
  role: "admin",
  memberships: [],
  is_active: true,
};

export const departments = [
  { code: "hr", name: "Human Resources", sensitive: true },
  { code: "finance", name: "Finance", sensitive: true },
  { code: "operations", name: "Operations", sensitive: false },
];

export function renderRoutes(routes: RouteObject[], initial: string) {
  const router = createMemoryRouter(routes, { initialEntries: [initial] });
  const utils = render(
    <Providers client={createQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, ...utils };
}
