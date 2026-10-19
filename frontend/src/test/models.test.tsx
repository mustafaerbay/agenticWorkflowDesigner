import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiModelCard } from "@/components/business/AiModelCard";
import { stepEditOperations } from "@/business/stepEdits";
import ModelSettingsPage from "@/pages/ModelSettingsPage";
import { useAuthStore } from "@/stores/auth";
import type { BusinessPlan, Capability, Provider, Workflow } from "@/types";
import { invoiceExplanation, planWorkflow } from "./fixtures";
import { adminUser, json, mockFetch, renderRoutes } from "./helpers";

const providers: Provider[] = [
  { id: "p1", name: "Local", base_url: "http://ollama:11434/v1", default_model: "llama3", api_key_ref: null, api_key_configured: false, created_at: "2026-10-01T00:00:00Z", timeout_seconds: 120, temperature: 0.2, max_tokens: 2048 },
  { id: "p2", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", default_model: "openai/gpt-4o-mini", api_key_ref: "OPENROUTER_KEY", api_key_configured: true, is_default: true, created_at: "2026-10-02T00:00:00Z", timeout_seconds: 120, temperature: 0.2, max_tokens: 2048 },
] as Provider[];

const aiWorkflow = {
  ...planWorkflow,
  explanation: {
    ...invoiceExplanation,
    ai_model: { provider_id: "p2", provider: "OpenRouter", model: "openai/gpt-4o-mini", source: "default" },
    steps: invoiceExplanation.steps.map((s, i) =>
      i === 0 ? { ...s, ai_model: { provider_id: "p2", provider: "OpenRouter", model: "anthropic/claude-x", source: "step" } } : s,
    ),
  },
} as Workflow;

describe("AI model selection", () => {
  beforeEach(() => useAuthStore.setState({ token: "t", user: adminUser }));
  afterEach(() => vi.unstubAllGlobals());

  it("shows the workflow model and saves a new choice as a plan operation", async () => {
    const calls = mockFetch(({ method, path }) => {
      if (path === "/api/model-providers") return json(providers);
      if (method === "POST" && path === `/api/workflows/${aiWorkflow.id}/plan/apply`) return json(aiWorkflow);
      return undefined;
    });
    renderRoutes([{ path: "/", element: <AiModelCard workflow={aiWorkflow} canEdit /> }], "/");
    expect(screen.getByTestId("ai-model-summary")).toHaveTextContent("OpenRouter · openai/gpt-4o-mini · platform default · 1 step uses a different model");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /change model/i }));
    await screen.findByRole("option", { name: "Local" });
    await user.selectOptions(screen.getByLabelText("Provider"), "p1");
    await user.type(screen.getByLabelText("Model"), "llama3.1:70b");
    await user.click(screen.getByRole("button", { name: /save model/i }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      base_version: aiWorkflow.version,
      operations: [{ op: "set_ai_model", step_id: null, provider_id: "p1", model: "llama3.1:70b" }],
    });
  });

  it("turns a per-step model override into set_ai_model (AI steps only)", () => {
    const plan = {
      schema: "bp/1", title: "t", summary: "", department: "hr", trigger: { type: "manual", timezone: "UTC" }, inputs: [], settings: {}, ui: {},
      steps: [
        { id: "summary", kind: "action", title: "Summarize", description: "", capability: "text.summarize", params: { text: "x" } },
        { id: "notify", kind: "action", title: "Notify", description: "", capability: "notify.in_app", params: {} },
      ],
    } as unknown as BusinessPlan;
    const caps = [
      { id: "text.summarize", inputs: [{ key: "text", label: "Text", type: "string", required: true }], implementation: { kind: "agent", name: "communication" } },
      { id: "notify.in_app", inputs: [], implementation: { kind: "tool", name: "notify_user" } },
    ] as unknown as Capability[];
    const blank = { title: "", description: "", params: {}, instructions: "", retry: "" };
    const ops = stepEditOperations(
      plan,
      {
        summary: { ...blank, title: "Summarize", params: { text: "x" }, aiProvider: "p1", aiModel: "" },
        notify: { ...blank, title: "Notify", aiProvider: "p1", aiModel: "ignored" },
      },
      caps,
    );
    expect(ops).toEqual([{ op: "set_ai_model", step_id: "summary", provider_id: "p1", model: null }]);
  });

  it("shows which provider is the default and which runs the AI builder", async () => {
    const calls = mockFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/model-providers") return json(providers);
      if (method === "POST" && path === "/api/model-providers/p1/role") return json({ ...providers[0], use_for_designer: true });
      return undefined;
    });
    renderRoutes([{ path: "/", element: <ModelSettingsPage /> }], "/");
    const local = await screen.findByTestId("roles-Local");
    const router = screen.getByTestId("roles-OpenRouter");
    expect(router).toHaveTextContent("Default for AI steps");
    expect(router).toHaveTextContent("AI builder (automatic)");
    expect(local).not.toHaveTextContent("Default for AI steps");
    await userEvent.setup().click(within(local).getByRole("button", { name: "Use for AI builder" }));
    await vi.waitFor(() => expect(calls.some((c) => c.path === "/api/model-providers/p1/role")).toBe(true));
    expect(calls.find((c) => c.path === "/api/model-providers/p1/role")!.body).toEqual({ role: "designer" });
  });
});
