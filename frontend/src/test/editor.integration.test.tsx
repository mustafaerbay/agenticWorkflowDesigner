import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/App";
import { createQueryClient } from "@/lib/queryClient";
import WorkflowEditorPage from "@/pages/WorkflowEditorPage";
import { useAuthStore } from "@/stores/auth";
import type { Workflow, WorkflowDefinition } from "@/types";
import { useEditorStore } from "@/workflow/editor/store";

const WF_ID = "11111111-1111-1111-1111-111111111111";

const baseWorkflow: Workflow = {
  id: WF_ID,
  name: "Integration WF",
  description: "",
  version: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  node_count: 0,
  last_run_status: null,
  is_example: false,
  definition: { nodes: [], edges: [], settings: { max_loop_iterations: 5, max_total_steps: 100, max_duration_seconds: 3600 } },
};

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("Workflow editor integration", () => {
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    useAuthStore.setState({ token: "test-token", user: { id: "u", email: "a@b.c", name: "A", role: "admin" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
        const path = url.split("?")[0];
        if (method === "GET" && path === `/api/workflows/${WF_ID}`) return json(baseWorkflow);
        if (method === "PUT" && path === `/api/workflows/${WF_ID}`) {
          const b = body as { name: string; definition: WorkflowDefinition };
          return json({ ...baseWorkflow, name: b.name, version: 2, definition: b.definition, node_count: b.definition.nodes.length });
        }
        if (method === "GET" && path === "/api/tools") {
          return json([{ name: "run_tests", description: "Run the test suite", parameters: {}, dangerous: false }]);
        }
        if (method === "GET" && ["/api/agents", "/api/agents/presets", "/api/model-providers"].includes(path!)) return json([]);
        return json({ detail: `unexpected ${method} ${url}` }, 404);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useEditorStore.getState().reset();
  });

  it("builds a workflow with palette + condition builder and saves the exact definition", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter([{ path: "/workflows/:id/edit", element: <WorkflowEditorPage /> }], {
      initialEntries: [`/workflows/${WF_ID}/edit`],
    });
    render(
      <Providers client={createQueryClient()}>
        <RouterProvider router={router} />
      </Providers>,
    );

    // Wait until the workflow is loaded into the editor
    await screen.findByLabelText("Workflow name");
    expect(screen.getByLabelText("Workflow name")).toHaveValue("Integration WF");

    // --- Add nodes through the palette (click-to-add uses the same path as drag & drop)
    await user.click(screen.getByTestId("palette-start"));
    await user.click(screen.getByTestId("palette-agent"));
    await user.click(screen.getByTestId("palette-condition"));
    await user.click(screen.getByTestId("palette-end"));

    const ids = useEditorStore.getState().nodes.map((n) => n.id);
    expect(ids).toEqual(["start_1", "agent_1", "condition_1", "end_1"]);
    expect(await screen.findByTestId("node-condition_1")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    // --- Connect them via the store's onConnect (React Flow handle drags aren't possible in jsdom)
    act(() => {
      const s = useEditorStore.getState();
      s.onConnect({ source: "start_1", target: "agent_1", sourceHandle: "out", targetHandle: "in" });
      s.onConnect({ source: "agent_1", target: "condition_1", sourceHandle: "out", targetHandle: "in" });
      s.onConnect({ source: "condition_1", target: "end_1", sourceHandle: "true", targetHandle: "in" });
      s.onConnect({ source: "condition_1", target: "agent_1", sourceHandle: "false", targetHandle: "in" });
    });

    // --- Select the condition node and configure its rule visually
    act(() => useEditorStore.getState().selectOnly(["condition_1"]));
    const panel = await screen.findByLabelText("Condition configuration");
    const branch = within(panel).getByTestId("branch-0");

    // 1st comparison: agent_1.output.coverage >= 80
    const leftRefs = within(branch).getAllByLabelText("Left operand reference");
    expect(leftRefs).toHaveLength(1);
    await user.type(leftRefs[0]!, "agent_1.output.coverage");
    await user.keyboard("{Escape}");
    await user.selectOptions(within(branch).getByLabelText("Operator"), "gte");
    const right = within(branch).getByLabelText("Right value");
    await user.clear(right);
    await user.type(right, "80");

    // 2nd comparison: agent_1.output.tests_passed is_true
    await user.click(within(branch).getByRole("button", { name: /^Condition$/ }));
    const left2 = within(branch).getAllByLabelText("Left operand reference")[1]!;
    await user.type(left2, "agent_1.output.tests_passed");
    await user.keyboard("{Escape}");
    await user.selectOptions(within(branch).getAllByLabelText("Operator")[1]!, "is_true");

    // Rename the branch label
    const label = within(branch).getByLabelText("Branch label");
    await user.clear(label);
    await user.type(label, "Ready");

    // --- Save (button)
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`/api/workflows/${WF_ID}`);
    expect(put.headers.Authorization).toBe("Bearer test-token");
    const body = put.body as { name: string; definition: WorkflowDefinition };
    expect(body.name).toBe("Integration WF");

    const def = body.definition;
    expect(def.nodes.map((n) => [n.id, n.type])).toEqual([
      ["start_1", "start"],
      ["agent_1", "agent"],
      ["condition_1", "condition"],
      ["end_1", "end"],
    ]);
    for (const n of def.nodes) {
      expect(Object.keys(n).sort()).toEqual(["data", "id", "position", "type"]);
      expect(Number.isInteger(n.position.x) && Number.isInteger(n.position.y)).toBe(true);
    }
    expect(def.edges).toEqual([
      { id: "e1", source: "start_1", target: "agent_1", sourceHandle: "out", targetHandle: "in" },
      { id: "e2", source: "agent_1", target: "condition_1", sourceHandle: "out", targetHandle: "in" },
      { id: "e3", source: "condition_1", target: "end_1", sourceHandle: "true", targetHandle: "in" },
      { id: "e4", source: "condition_1", target: "agent_1", sourceHandle: "false", targetHandle: "in" },
    ]);
    const cond = def.nodes.find((n) => n.id === "condition_1")!;
    expect(cond.data.config).toEqual({
      branches: [
        {
          handle: "true",
          label: "Ready",
          rule: {
            op: "and",
            rules: [
              { op: "gte", left: { ref: "agent_1.output.coverage" }, right: { value: 80 } },
              { op: "is_true", left: { ref: "agent_1.output.tests_passed" } },
            ],
          },
        },
      ],
      default_handle: "false",
    });
    expect(def.nodes.find((n) => n.id === "agent_1")!.data.config).toMatchObject({ kind: "llm", tools: [] });
    expect(def.settings).toEqual({ max_loop_iterations: 5, max_total_steps: 100, max_duration_seconds: 3600 });

    // Saved state reflected in the toolbar
    await screen.findByText("All changes saved");
    expect(screen.getByText("v2")).toBeInTheDocument();
  });

  it("saves with Ctrl/Cmd+S", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter([{ path: "/workflows/:id/edit", element: <WorkflowEditorPage /> }], {
      initialEntries: [`/workflows/${WF_ID}/edit`],
    });
    render(
      <Providers client={createQueryClient()}>
        <RouterProvider router={router} />
      </Providers>,
    );
    await screen.findByLabelText("Workflow name");
    await user.click(screen.getByTestId("palette-start"));
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const body = calls.find((c) => c.method === "PUT")!.body as { definition: WorkflowDefinition };
    expect(body.definition.nodes.map((n) => n.id)).toEqual(["start_1"]);
  });
});
