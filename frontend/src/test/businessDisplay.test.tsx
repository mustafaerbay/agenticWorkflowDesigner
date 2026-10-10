import { act, render, screen, within } from "@testing-library/react";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffView } from "@/components/business/Explanation";
import { diffLines } from "@/business/diff";
import { useUiStore } from "@/stores/ui";
import type { PlanDiff } from "@/types";
import { nodeTypes } from "@/workflow/nodes/WorkflowNodes";
import { definitionToFlow, flowToDefinition } from "@/workflow/serialization";
import { invoiceDefinition } from "./fixtures";

function Canvas() {
  const { nodes, edges } = definitionToFlow(invoiceDefinition);
  return (
    <ReactFlowProvider>
      <div style={{ width: 1000, height: 800 }}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} />
      </div>
    </ReactFlowProvider>
  );
}

describe("business node display", () => {
  afterEach(() => useUiStore.setState({ advancedMode: false }));

  it("shows business titles and plain-language subtitles by default, technical details in Advanced mode", async () => {
    useUiStore.setState({ advancedMode: false });
    render(<Canvas />);
    const tool = await screen.findByTestId("node-check_fields");
    expect(tool).toHaveAttribute("data-display", "business");
    expect(within(tool).getByText("Check invoice fields")).toBeInTheDocument();
    expect(within(tool).getByText("Documents (built-in)")).toBeInTheDocument();
    // no technical id / tool name in business mode
    expect(within(tool).queryByText("check_fields")).toBeNull();
    expect(within(tool).queryByText("doc_check_fields")).toBeNull();

    const approval = screen.getByTestId("node-manager_approval");
    expect(within(approval).getByText("Needs approval")).toBeInTheDocument();
    expect(within(approval).getByText(/Policy/)).toBeInTheDocument();

    act(() => useUiStore.getState().setAdvancedMode(true));
    expect(tool).toHaveAttribute("data-display", "advanced");
    expect(within(tool).getByText("doc_check_fields")).toBeInTheDocument();
    expect(within(tool).getByText("check_fields")).toBeInTheDocument();
    expect(within(approval).queryByText("Needs approval")).toBeNull();
  });

  it("persists the Advanced toggle in the ui store", () => {
    useUiStore.getState().setAdvancedMode(true);
    expect(JSON.parse(localStorage.getItem("agentic-ui") ?? "{}").state.advancedMode).toBe(true);
  });

  it("round-trips business data and compiler metadata through the editor serialization", () => {
    const { nodes, edges, settings } = definitionToFlow(invoiceDefinition);
    expect(flowToDefinition(nodes, edges, settings, invoiceDefinition.meta)).toEqual(invoiceDefinition);
  });
});

const diff: PlanDiff = {
  added: [{ step_id: "manager_approval", title: "Manager approval", kind: "approval", policy_inserted: false }],
  removed: [{ step_id: "old_notify", title: "Notify HR by chat", kind: "action" }],
  changed: [
    {
      step_id: "send_email",
      title: "Send confirmation email",
      fields: [
        { field: "title", before: "Send email", after: "Send confirmation email" },
        { field: "retry", before: null, after: { max_attempts: 3, backoff_seconds: 5 } },
      ],
    },
  ],
  reordered: false,
  trigger_changed: false,
  inputs_added: ["leave_type"],
  inputs_removed: [],
  title_changed: false,
  settings_changed: false,
  layout_only: false,
};

describe("diff rendering", () => {
  it("describes a modification proposal in plain language", () => {
    const lines = diffLines(diff);
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ["added", "Added approval step “Manager approval”"],
      ["removed", "Removed action step “Notify HR by chat”"],
      ["changed", "Changed “Send confirmation email”"],
      ["added", "New information requested: leave_type"],
    ]);
    expect(lines[2]!.detail).toEqual(["Name: Send email → Send confirmation email", "Retries: — → Up to 3 attempts"]);
  });

  it("highlights added, removed and changed steps", () => {
    render(<DiffView diff={diff} />);
    const view = screen.getByTestId("diff-view");
    const items = within(view).getAllByRole("listitem").filter((li) => li.hasAttribute("data-diff-kind"));
    expect(items.map((i) => i.getAttribute("data-diff-kind"))).toEqual(["added", "removed", "changed", "added"]);
    expect(within(view).getByText("Added approval step “Manager approval”")).toBeInTheDocument();
    expect(within(view).getByText("Name: Send email → Send confirmation email")).toBeInTheDocument();
    expect(items[0]!.className).toMatch(/success/);
    expect(items[1]!.className).toMatch(/destructive/);
  });

  it("shows an empty message when nothing changed", () => {
    render(<DiffView diff={null} empty="Nothing changed" />);
    expect(screen.getByText("Nothing changed")).toBeInTheDocument();
  });
});
