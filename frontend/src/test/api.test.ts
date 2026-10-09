import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, setUnauthorizedHandler } from "@/services/api";
import { useAuthStore } from "@/stores/auth";

const res = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("api client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the bearer token and builds query strings under /api", async () => {
    useAuthStore.setState({ token: "abc" });
    const f = vi.fn(async () => res(200, []));
    vi.stubGlobal("fetch", f);
    await api.listExecutions({ status: "FAILED", search: "" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/executions?limit=50&status=FAILED");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer abc");
  });

  it("does not send auth on login", async () => {
    useAuthStore.setState({ token: "abc" });
    const f = vi.fn(async () => res(200, { access_token: "t", token_type: "bearer", user: {} }));
    vi.stubGlobal("fetch", f);
    await api.login("a@b.c", "pw");
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("calls the unauthorized handler on 401", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => res(401, { detail: "expired" })));
    await expect(api.stats()).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("exposes ValidationResult details from 422 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(422, { detail: { valid: false, errors: [{ code: "no_end", message: "No end node" }], warnings: [] } })),
    );
    const err = (await api.executeWorkflow("w", {}).catch((e) => e)) as ApiError;
    expect(err.status).toBe(422);
    expect(err.message).toBe("No end node");
    expect(err.validation?.errors[0]?.code).toBe("no_end");
  });

  it("formats FastAPI validation arrays and handles 204", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(422, { detail: [{ loc: ["body", "name"], msg: "field required" }] })));
    await expect(api.createAgent({ name: "", kind: "llm", config: { kind: "llm" } })).rejects.toThrow("body.name: field required");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api.deleteWorkflow("w")).resolves.toBeUndefined();
  });
});
