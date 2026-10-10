import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunWorkflowDialog } from "@/components/RunWorkflowDialog";
import { useAuthStore } from "@/stores/auth";
import type { BusinessPlan } from "@/types";
import { adminUser, json, mockFetch, renderRoutes } from "./helpers";

const plan = {
  schema: "bp/1",
  title: "Leave",
  summary: "",
  department: "hr",
  trigger: { type: "manual", timezone: "UTC" },
  inputs: [
    { key: "employee_email", label: "Employee email", type: "email", required: true, description: "" },
    { key: "days", label: "Number of days", type: "number", required: true, description: "", example: 3 },
    { key: "reason", label: "Reason", type: "string", required: false, description: "" },
  ],
  steps: [],
  settings: { max_loop_iterations: 5, max_total_steps: 100, max_duration_seconds: 3600 },
  ui: {},
} as unknown as BusinessPlan;

describe("Run dialog for business workflows", () => {
  beforeEach(() => useAuthStore.setState({ token: "t", user: adminUser }));
  afterEach(() => vi.unstubAllGlobals());

  it("shows a form instead of JSON and sends typed values", async () => {
    const calls = mockFetch(({ method, path }) => {
      if (path === "/api/tools") return json([]);
      if (method === "POST" && path === "/api/workflows/wf-1/execute") return json({ id: "run-1" }, 201);
      return undefined;
    });
    renderRoutes(
      [
        { path: "/", element: <RunWorkflowDialog open onOpenChange={() => {}} workflowId="wf-1" workflowName="Leave" definition={null} plan={plan} department="hr" /> },
        { path: "/executions/:id", element: <p>execution page</p> },
      ],
      "/",
    );
    expect(screen.queryByLabelText("Input (JSON)")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /run workflow/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please fill in: Employee email");
    await user.type(screen.getByLabelText(/Employee email/), "jane@example.com");
    await user.click(screen.getByRole("button", { name: /run workflow/i }));
    await screen.findByText("execution page");
    const body = calls.find((c) => c.path === "/api/workflows/wf-1/execute")!.body;
    expect(body).toEqual({ input: { employee_email: "jane@example.com", days: 3 } });
  });
});
