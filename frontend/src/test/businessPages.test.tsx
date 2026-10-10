import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ApprovalsPage from "@/pages/ApprovalsPage";
import ExecutionPage from "@/pages/ExecutionPage";
import TemplatesPage from "@/pages/TemplatesPage";
import { stepEditOperations } from "@/business/stepEdits";
import { builderDepartments, permissionStepId } from "@/business/labels";
import { useAuthStore } from "@/stores/auth";
import type { Approval, Capability, Run } from "@/types";
import { invoiceDefinition, invoiceExplanation, invoicePlan } from "./fixtures";
import { adminUser, departments, json, mockFetch, renderRoutes } from "./helpers";

const checkFields: Capability = {
  id: "doc.check_fields",
  name: "Check document fields",
  description: "",
  category: "documents",
  app: "Documents (built-in)",
  inputs: [
    { key: "document", label: "Document", type: "file", required: true },
    { key: "required_fields", label: "Required fields", type: "list", required: true },
  ],
  outputs: [],
  side_effect: "none",
  sensitivity: "low",
  departments: ["*"],
  connector: null,
  connector_label: null,
  needs_approval: false,
  implementation: { kind: "tool", name: "doc_check_fields" },
  status: "available",
  status_reason: null,
};

describe("business helpers", () => {
  it("turns step edits into typed plan operations (only what changed)", () => {
    const ops = stepEditOperations(
      invoicePlan,
      {
        check_fields: { title: "Check the invoice", description: "", params: { required_fields: "invoice number, IBAN, VAT id" }, instructions: "", retry: "3" },
        manager_approval: { title: "Finance manager approval", description: "", params: {}, instructions: "Check amount and IBAN", retry: "" },
        notify_ap: { title: "Email accounts payable", description: "", params: {}, instructions: "", retry: "" },
      },
      [checkFields],
    );
    expect(ops).toEqual([
      { op: "update_step", step_id: "check_fields", title: "Check the invoice", params: { required_fields: ["invoice number", "IBAN", "VAT id"] } },
      { op: "set_retry", step_id: "check_fields", max_attempts: 3, backoff_seconds: 5 },
      { op: "update_step", step_id: "manager_approval", instructions: "Check amount and IBAN" },
    ]);
  });

  it("resolves permission step ids from titles and limits builder departments by role", () => {
    expect(permissionStepId(invoiceExplanation.permissions[0]!, invoicePlan, invoiceExplanation)).toBe("notify_ap");
    const member = { ...adminUser, role: "editor" as const, memberships: [{ department: "hr", roles: ["builder" as const] }, { department: "finance", roles: ["member" as const] }] };
    expect(builderDepartments(member, departments).map((d) => d.code)).toEqual(["hr"]);
    expect(builderDepartments({ ...member, role: "viewer" }, departments)).toEqual([]);
    expect(builderDepartments(adminUser, departments)).toHaveLength(3);
  });
});

describe("approvals governance", () => {
  beforeEach(() => useAuthStore.setState({ token: "t", user: adminUser }));
  afterEach(() => vi.unstubAllGlobals());

  it("shows department, separation of duties and disables deciding when not allowed", async () => {
    const approval: Approval = {
      id: "a1",
      run_id: "r1",
      node_id: "manager_approval",
      workflow_name: "Invoice processing",
      title: "Finance manager approval",
      description: null,
      status: "pending",
      requested_at: "2026-10-10T00:00:00Z",
      decided_at: null,
      decided_by: null,
      comment: null,
      department: "finance",
      required_role: "approver",
      separation_of_duties: true,
      can_decide: false,
      reason_cannot_decide: "You started this run, so someone else must approve it.",
    };
    mockFetch(({ path }) => {
      if (path === "/api/approvals") return json([approval]);
      if (path === "/api/departments") return json(departments);
      return undefined;
    });
    renderRoutes([{ path: "/", element: <ApprovalsPage /> }], "/");
    expect(await screen.findByText("Finance manager approval")).toBeInTheDocument();
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("Different approver required")).toBeInTheDocument();
    expect(screen.getByTestId("cannot-decide")).toHaveTextContent("You started this run, so someone else must approve it.");
    expect(screen.getByRole("button", { name: /Approve/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Reject/ })).toBeDisabled();
  });
});

describe("simulation runs", () => {
  beforeEach(() => useAuthStore.setState({ token: "t", user: adminUser }));
  afterEach(() => vi.unstubAllGlobals());

  it("marks simulation runs and simulated step outputs", async () => {
    const run: Run = {
      id: "run-sim",
      workflow_id: "wf-1",
      workflow_name: "Invoice processing",
      workflow_version: 3,
      status: "COMPLETED",
      created_at: "2026-10-10T00:00:00Z",
      started_at: "2026-10-10T00:00:00Z",
      finished_at: "2026-10-10T00:00:05Z",
      steps: 3,
      error: null,
      mode: "simulation",
      triggered_by: "manual",
      department: "finance",
      input: {},
      output: {},
      definition: invoiceDefinition,
      last_event_seq: 0,
      node_runs: [
        {
          id: "nr1",
          node_id: "check_fields",
          node_type: "tool",
          label: "Check invoice fields",
          iteration: 1,
          attempt: 1,
          status: "COMPLETED",
          input: {},
          output: { missing: [], _simulated: true, _simulation_note: "Sample output used for the simulation" },
          error: null,
          selected_handle: null,
          started_at: "2026-10-10T00:00:01Z",
          finished_at: "2026-10-10T00:00:02Z",
          duration_ms: 1000,
          logs: [],
          tool_calls: [],
          usage: null,
          agent_kind: null,
          model: null,
        },
      ],
    };
    mockFetch(({ path }) => {
      if (path === "/api/executions/run-sim") return json(run);
      if (path === "/api/executions/run-sim/events") return json([]);
      return undefined;
    });
    renderRoutes([{ path: "/executions/:id", element: <ExecutionPage /> }], "/executions/run-sim");
    const banner = await screen.findByTestId("simulation-banner");
    expect(banner).toHaveTextContent("Simulation — nothing was sent or changed");
    const node = await screen.findByTestId("node-check_fields");
    expect(within(node).getByTestId("simulated-badge")).toBeInTheDocument();
    // plain click (d3-zoom's mousedown handler needs a real window view)
    fireEvent.click(within(node).getByText("Check invoice fields"));
    expect(await screen.findByTestId("node-simulated")).toHaveTextContent("Sample output used for the simulation");
  });
});

describe("template gallery", () => {
  beforeEach(() => useAuthStore.setState({ token: "t", user: adminUser }));
  afterEach(() => vi.unstubAllGlobals());

  it("filters by department, shows requirements and creates a workflow from a template", async () => {
    const templates = [
      { id: "fin_invoice", name: "Invoice processing", department: "finance", description: "Check invoices", runs_locally: false, needs: [{ connector: "smtp", label: "Email", status: "requires_connection" }], step_count: 3, plan: invoicePlan, explanation: invoiceExplanation },
      { id: "hr_docs", name: "Document verification", department: "hr", description: "Verify documents", runs_locally: true, needs: [], step_count: 2, plan: invoicePlan, explanation: invoiceExplanation },
    ];
    const calls = mockFetch(({ method, path, url }) => {
      if (path === "/api/departments") return json(departments);
      if (method === "GET" && path === "/api/templates") {
        const dep = new URL(url, "http://x").searchParams.get("department");
        return json(dep ? templates.filter((t) => t.department === dep) : templates);
      }
      if (method === "POST" && path === "/api/templates/fin_invoice/use") return json({ id: "wf-9", name: "Invoice processing" }, 201);
      return undefined;
    });
    const user = userEvent.setup();
    const { router } = renderRoutes(
      [
        { path: "/templates", element: <TemplatesPage /> },
        { path: "/workflows/:id", element: <p>Overview</p> },
      ],
      "/templates",
    );
    expect(await screen.findByText("Runs locally")).toBeInTheDocument();
    expect(screen.getByText(/Needs: Email/)).toBeInTheDocument();
    expect(screen.getByText("3 steps")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Human Resources" }));
    await waitFor(() => expect(screen.queryByText("Invoice processing")).toBeNull());
    await user.click(screen.getByRole("button", { name: "All departments" }));

    await user.click(await screen.findByRole("button", { name: "Preview Invoice processing" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("list", { name: "Workflow steps" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Use template/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows/wf-9"));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ department: "finance" });
  });
});
