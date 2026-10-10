import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BuilderPage from "@/pages/BuilderPage";
import { useAuthStore } from "@/stores/auth";
import type { DesignerSession, PlanDiff } from "@/types";
import { invoiceDefinition, invoiceExplanation, invoicePlan, makeProposal } from "./fixtures";
import { adminUser, departments, json, mockFetch, renderRoutes, type Call } from "./helpers";

const SID = "sess-1";

const diff: PlanDiff = {
  added: [{ step_id: "manager_approval_2", title: "Manager approval before email", kind: "approval", policy_inserted: false }],
  removed: [],
  changed: [],
  reordered: false,
  trigger_changed: false,
  inputs_added: [],
  inputs_removed: [],
  title_changed: false,
  settings_changed: false,
  layout_only: false,
};

function session(over: Partial<DesignerSession> = {}): DesignerSession {
  return {
    id: SID,
    department: "finance",
    workflow_id: null,
    base_version: null,
    messages: [],
    plan: null,
    definition: null,
    explanation: null,
    proposal: null,
    can_undo: false,
    can_redo: false,
    ...over,
  };
}

const routes = [
  { path: "/builder", element: <BuilderPage /> },
  { path: "/builder/:sessionId", element: <BuilderPage /> },
  { path: "/workflows/:id", element: <p>Workflow page</p> },
];

describe("AI builder", () => {
  let calls: Call[];
  let state: DesignerSession;

  beforeEach(() => {
    useAuthStore.setState({ token: "t", user: adminUser });
    state = session();
    calls = mockFetch(({ method, path, body }) => {
      if (method === "GET" && path === "/api/departments") return json(departments);
      if (method === "GET" && path === "/api/designer/status") return json({ available: true, provider: "Local", model: "m", reason: null });
      if (method === "POST" && path === "/api/designer/sessions") {
        const b = body as { prompt: string };
        state = session({
          messages: [
            { role: "user", content: b.prompt, at: "2026-10-10T00:00:00Z" },
            { role: "assistant", content: makeProposal().summary, at: "2026-10-10T00:00:01Z", proposal_kind: "create" },
          ],
          proposal: makeProposal(),
        });
        return json(state, 201);
      }
      if (method === "GET" && path === `/api/designer/sessions/${SID}`) return json(state);
      if (method === "POST" && path === `/api/designer/sessions/${SID}/messages`) {
        const m = (body as { message: string }).message;
        state = {
          ...state,
          messages: [...state.messages, { role: "user", content: m, at: "x" }, { role: "assistant", content: "I added a manager approval before the email.", at: "y" }],
          proposal: makeProposal({ kind: "modify", diff, summary: "I added a manager approval before the email." }),
        };
        return json(state);
      }
      if (method === "POST" && path === `/api/designer/sessions/${SID}/accept`) {
        state = { ...state, plan: invoicePlan, definition: invoiceDefinition, explanation: invoiceExplanation, proposal: null, can_undo: true };
        return json(state);
      }
      if (method === "POST" && path === `/api/designer/sessions/${SID}/save`) {
        return json({ id: "wf-new", name: (body as { name?: string }).name ?? "x", version: 1, has_plan: true });
      }
      return undefined;
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates a proposal from a description, refines it, accepts and saves", async () => {
    const user = userEvent.setup();
    const { router } = renderRoutes(routes, "/builder");

    // Department picker defaults to the first allowed department; example prompts fill the box.
    const dept = await screen.findByLabelText("Department");
    await user.selectOptions(dept, "finance");
    await user.click(screen.getByRole("button", { name: /Process an uploaded invoice/ }));
    expect((screen.getByLabelText("Describe the task") as HTMLTextAreaElement).value).toMatch(/^Process an uploaded invoice/);
    expect(screen.getByText(/Nothing is saved until you choose Save workflow/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Suggest a workflow/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/builder/${SID}`));
    const create = calls.find((c) => c.method === "POST" && c.path === "/api/designer/sessions")!;
    expect(create.body).toEqual({ prompt: expect.stringMatching(/^Process an uploaded invoice/), department: "finance" });

    // Proposal with business step cards
    expect(await screen.findByText("Suggested workflow")).toBeInTheDocument();
    expect(screen.getByTestId("unsaved-badge")).toHaveTextContent("Not saved yet");
    const steps = screen.getByRole("list", { name: "Workflow steps" });
    expect(within(steps).getByText("Check invoice fields")).toBeInTheDocument();
    expect(within(steps).getByText("Finance manager approval")).toBeInTheDocument();
    expect(within(steps).getAllByText("Required by policy").length).toBeGreaterThan(0);
    // Save is not possible while a proposal is pending
    expect(screen.getByRole("button", { name: /Save workflow/ })).toBeDisabled();

    // Requirements tab: integration status + unmet needs + Connect link for admins
    await user.click(screen.getByRole("tab", { name: /Requirements/ }));
    const req = await screen.findByTestId("requirements");
    expect(within(req).getByText("Email")).toBeInTheDocument();
    expect(within(req).getAllByText("Needs connection").length).toBeGreaterThan(0);
    expect(within(req).getByText("Look up the employee's manager")).toBeInTheDocument();
    expect(within(req).getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/settings/connections");

    // Ask for a change
    await user.type(screen.getByLabelText("Ask for a change"), "Add manager approval before sending the email");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));
    expect(await screen.findByText("Proposed changes")).toBeInTheDocument();
    const msg = calls.find((c) => c.path === `/api/designer/sessions/${SID}/messages`)!;
    expect(msg.body).toEqual({ message: "Add manager approval before sending the email" });

    // The Changes tab is shown with the diff highlighted
    const diffView = await screen.findByTestId("diff-view");
    expect(within(diffView).getByText("Added approval step “Manager approval before email”")).toBeInTheDocument();

    // Accept, then save
    await user.click(screen.getByRole("button", { name: /Accept changes/ }));
    expect(await screen.findByText("Current workflow")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /Save workflow/ });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("Invoice processing");
    await user.clear(name);
    await user.type(name, "Invoice check");
    await user.click(within(dialog).getByRole("button", { name: /Save workflow/ }));

    await waitFor(() => expect(calls.some((c) => c.path === `/api/designer/sessions/${SID}/save`)).toBe(true));
    expect(calls.find((c) => c.path === `/api/designer/sessions/${SID}/save`)!.body).toEqual({ name: "Invoice check" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows/wf-new"));
    // Nothing was saved before the explicit Save
    const saveIndex = calls.findIndex((c) => c.path.endsWith("/save"));
    expect(calls.slice(0, saveIndex).some((c) => c.path.endsWith("/save") || c.path === "/api/workflows")).toBe(false);
  });

  it("shows a setup card when no AI model is configured", async () => {
    mockFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/departments") return json(departments);
      if (method === "GET" && path === "/api/designer/status")
        return json({ available: false, provider: null, model: null, reason: "No AI model is configured." });
      return undefined;
    });
    renderRoutes(routes, "/builder");
    const card = await screen.findByTestId("ai-setup-card");
    expect(within(card).getByRole("link", { name: /Configure an AI model/ })).toHaveAttribute("href", "/settings/models");
    expect(within(card).getByRole("link", { name: /template/ })).toHaveAttribute("href", "/templates");
    expect(screen.getByRole("button", { name: /Suggest a workflow/ })).toBeDisabled();
  });
});
