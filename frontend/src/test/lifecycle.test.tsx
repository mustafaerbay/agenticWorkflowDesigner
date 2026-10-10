import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnableDialog } from "@/components/business/EnableDialog";
import { SimulateDialog } from "@/components/business/SimulateDialog";
import { buildSimulationRequest } from "@/business/inputs";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { Explanation, Workflow } from "@/types";
import { invoiceExplanation, invoicePlan, planWorkflow } from "./fixtures";
import { adminUser, json, mockFetch, renderRoutes } from "./helpers";

const readyExplanation: Explanation = {
  ...invoiceExplanation,
  integrations: [{ connector: "smtp", label: "Email", status: "available", steps: ["Email accounts payable"] }],
  permissions: [
    { step: "Check invoice fields", capability: "Check fields", side_effect: "internal", needs_authorization: false },
    { step: "Email accounts payable", capability: "Send email", side_effect: "communication", needs_authorization: true },
    { step: "Update ERP", capability: "Update record", side_effect: "external_write", needs_authorization: true, step_id: "update_erp" },
  ],
  steps: [
    ...invoiceExplanation.steps.map((s) => ({ ...s, status: "available" as const })),
    { step_id: "update_erp", title: "Update ERP", kind: "action", policy_inserted: false, app: "Business system", side_effect: "external_write" },
  ],
  findings: [],
  ready_to_enable: true,
};

describe("Enable dialog", () => {
  beforeEach(() => useAuthStore.setState({ token: "t", user: adminUser }));
  afterEach(() => vi.unstubAllGlobals());

  function renderEnable(wf: Workflow) {
    return renderRoutes([{ path: "/", element: <EnableDialog workflow={wf} open onOpenChange={() => {}} canConnect /> }], "/");
  }

  it("requires every acknowledgement and sends the step ids", async () => {
    const calls = mockFetch(({ method, path }) =>
      method === "POST" && path === "/api/workflows/wf-1/enable" ? json({ ...planWorkflow, status: "enabled", enabled_version: 3 }) : undefined,
    );
    const user = userEvent.setup();
    renderEnable({ ...planWorkflow, explanation: readyExplanation });

    const enable = await screen.findByRole("button", { name: /Enable workflow/ });
    expect(enable).toBeDisabled();
    const send = screen.getByRole("checkbox", { name: /send messages outside the workflow/ });
    const change = screen.getByRole("checkbox", { name: /change data in Business system/ });
    // internal steps don't need authorization
    expect(screen.queryByText(/create items inside this platform/)).toBeNull();

    await user.click(send);
    expect(enable).toBeDisabled();
    await user.click(change);
    expect(enable).toBeEnabled();
    await user.click(change);
    expect(enable).toBeDisabled();
    await user.click(change);
    await user.click(enable);

    await waitFor(() => expect(calls.some((c) => c.path === "/api/workflows/wf-1/enable")).toBe(true));
    const body = calls.find((c) => c.path === "/api/workflows/wf-1/enable")!.body as { acknowledgements: string[] };
    expect(body.acknowledgements.sort()).toEqual(["notify_ap", "update_erp"]);
  });

  it("lists setup requirements and keeps Enable disabled when the workflow is not ready", async () => {
    mockFetch(() => undefined);
    const user = userEvent.setup();
    renderEnable(planWorkflow); // invoiceExplanation: ready_to_enable false, email needs connection
    const region = await screen.findByRole("region", { name: "Setup requirements" });
    expect(within(region).getByText("Connect an email server (SMTP) for Finance.")).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "Connect" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /send messages/ }));
    expect(screen.getByRole("button", { name: /Enable workflow/ })).toBeDisabled();
  });

  it("shows missing acknowledgements returned by the server", async () => {
    mockFetch(({ path }) =>
      path === "/api/workflows/wf-1/enable"
        ? json({ detail: { message: "Authorize every sensitive step", findings: [], missing_acknowledgements: ["notify_ap"] } }, 422)
        : undefined,
    );
    const user = userEvent.setup();
    renderEnable({ ...planWorkflow, explanation: { ...readyExplanation, permissions: readyExplanation.permissions.slice(0, 2) } });
    await user.click(await screen.findByRole("checkbox", { name: /send messages/ }));
    await user.click(screen.getByRole("button", { name: /Enable workflow/ }));
    expect(await screen.findByText("Authorize every sensitive step")).toBeInTheDocument();
    expect(screen.getByText(/Still needs your authorization: notify_ap/)).toBeInTheDocument();
  });
});

describe("simulation", () => {
  beforeEach(() => useAuthStore.setState({ token: "t", user: adminUser }));
  afterEach(() => vi.unstubAllGlobals());

  it("builds the request body from inputs, approval choices and pretend results", () => {
    const r = buildSimulationRequest(invoicePlan, {
      values: { invoice: "file-9", amount: "12000", note: "" },
      approvals: { manager_approval: "reject" },
      stepOutputs: { check_fields: '{"missing": []}', notify_ap: "  " },
    });
    expect(r).toEqual({
      ok: true,
      body: {
        input: { invoice: "file-9", amount: 12000 },
        approvals: { manager_approval: "reject" },
        step_outputs: { check_fields: { missing: [] } },
      },
    });
    expect(buildSimulationRequest(invoicePlan, { values: { amount: "1" }, approvals: {}, stepOutputs: {} })).toEqual({
      ok: false,
      error: "Please fill in: Invoice file",
    });
    const bad = buildSimulationRequest(invoicePlan, { values: { invoice: "f", amount: "1" }, approvals: {}, stepOutputs: { check_fields: "[1]" } });
    expect(bad.ok).toBe(false);
  });

  it("uploads files, records approval choices and starts a simulation run", async () => {
    const calls = mockFetch(({ method, path }) => {
      if (method === "POST" && path === "/api/files")
        return json({ id: "file-123", name: "invoice.pdf", content_type: "application/pdf", size_bytes: 2048, department: "finance" }, 201);
      if (method === "POST" && path === "/api/workflows/wf-1/simulate") return json({ id: "run-sim", mode: "simulation" }, 201);
      return undefined;
    });
    const user = userEvent.setup();
    const { router } = renderRoutes(
      [
        {
          path: "/",
          element: <SimulateDialog workflowId="wf-1" workflowName="Invoice" plan={invoicePlan} department="finance" open onOpenChange={() => {}} />,
        },
        { path: "/executions/:id", element: <p>Execution</p> },
      ],
      "/",
    );
    const dialog = await screen.findByRole("dialog");
    const file = new File(["%PDF-1.4"], "invoice.pdf", { type: "application/pdf" });
    await user.upload(within(dialog).getByLabelText("Invoice file", { selector: "input[type=file]" }), file);
    expect(await within(dialog).findByText(/invoice\.pdf · 2 KB/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Amount/), "12000");
    await user.click(within(dialog).getByRole("radio", { name: "Reject" }));
    await user.click(within(dialog).getByRole("button", { name: /Run simulation/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/executions/run-sim"));
    const upload = calls.find((c) => c.path === "/api/files")!;
    expect(upload.rawBody).toBeInstanceOf(FormData);
    expect((upload.rawBody as FormData).get("department")).toBe("finance");
    expect(upload.headers["Content-Type"]).toBeUndefined();
    expect(calls.find((c) => c.path === "/api/workflows/wf-1/simulate")!.body).toEqual({
      input: { invoice: "file-123", amount: 12000 },
      approvals: { manager_approval: "reject" },
    });
  });

  it("uploads with multipart form data, never a JSON content type", async () => {
    const calls = mockFetch(() => json({ id: "f", name: "a.csv", content_type: "text/csv", size_bytes: 1, department: null }, 201));
    await api.uploadFile(new File(["a"], "a.csv", { type: "text/csv" }));
    expect(calls[0]!.rawBody).toBeInstanceOf(FormData);
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
    expect(calls[0]!.headers.Authorization).toBe("Bearer t");
  });
});
