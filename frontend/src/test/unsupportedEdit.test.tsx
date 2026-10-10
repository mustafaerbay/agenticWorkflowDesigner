import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkflowEditorPage from "@/pages/WorkflowEditorPage";
import { useAuthStore } from "@/stores/auth";
import type { WorkflowDefinition } from "@/types";
import { useEditorStore } from "@/workflow/editor/store";
import { planWorkflow } from "./fixtures";
import { adminUser, json, mockFetch, renderRoutes, type Call } from "./helpers";

describe("Advanced editor on a plan-based workflow", () => {
  let calls: Call[];
  let detached: boolean;

  beforeEach(() => {
    detached = false;
    useAuthStore.setState({ token: "t", user: adminUser });
    calls = mockFetch(({ method, path, body }) => {
      if (method === "GET" && path === "/api/workflows/wf-1") return json(planWorkflow);
      if (method === "PUT" && path === "/api/workflows/wf-1") {
        if (!detached) {
          return json(
            {
              detail: {
                message: "Some changes cannot be represented in this business workflow. Nothing was saved.",
                unsupported: [{ message: "Parallel branches are not supported in business workflows yet.", node_id: "parallel_1" }],
                operations: [],
              },
            },
            422,
          );
        }
        const b = body as { definition: WorkflowDefinition };
        return json({ ...planWorkflow, has_plan: false, plan: null, explanation: null, version: 4, definition: b.definition });
      }
      if (method === "POST" && path === "/api/workflows/wf-1/detach") {
        detached = true;
        return json({ ...planWorkflow, has_plan: false, plan: null, explanation: null });
      }
      if (method === "GET" && ["/api/tools", "/api/agents", "/api/agents/presets", "/api/model-providers"].includes(path)) return json([]);
      return undefined;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useEditorStore.getState().reset();
  });

  it("explains unsupported edits, highlights them, keeps the changes and offers detaching", async () => {
    const user = userEvent.setup();
    renderRoutes([{ path: "/workflows/:id/edit", element: <WorkflowEditorPage /> }], "/workflows/wf-1/edit");
    await screen.findByLabelText("Workflow name");
    expect(screen.getByText("Business workflow")).toBeInTheDocument();

    // A change the business plan cannot express
    await user.click(screen.getByTestId("palette-parallel"));
    expect(useEditorStore.getState().nodes.map((n) => n.id)).toContain("parallel_1");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Parallel branches are not supported in business workflows yet.")).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing was saved/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Editing with AI, the step-by-step business view and approvals/)).toBeInTheDocument();
    // the offending node is highlighted and nothing was dropped
    expect(useEditorStore.getState().invalidNodes.parallel_1).toEqual(["Parallel branches are not supported in business workflows yet."]);
    await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="parallel_1"]')).toHaveClass("node-invalid"));

    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useEditorStore.getState().nodes.map((n) => n.id)).toContain("parallel_1");
    expect(useEditorStore.getState().dirty).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    // Save again, then detach: the same graph is saved afterwards
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    const again = await screen.findByRole("dialog");
    await user.click(within(again).getByRole("button", { name: /Detach from business plan/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(3));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/workflows/wf-1/detach")).toBe(true);
    const lastPut = calls.filter((c) => c.method === "PUT").at(-1)!.body as { definition: WorkflowDefinition };
    expect(lastPut.definition.nodes.map((n) => n.id)).toContain("parallel_1");
    expect(lastPut.definition.nodes.find((n) => n.id === "check_fields")!.data.business?.title).toBe("Check invoice fields");
    await screen.findByText("All changes saved");
  });
});
