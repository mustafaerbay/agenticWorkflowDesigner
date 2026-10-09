import { describe, expect, it } from "vitest";
import type { ToolInfo, WorkflowDefinition } from "@/types";
import { missingRequired, runInputSpec } from "@/workflow/runInputs";

const tools: ToolInfo[] = [
  {
    name: "git_clone",
    description: "",
    dangerous: false,
    parameters: { type: "object", properties: { repo_url: {}, ref: {}, path: {} }, required: ["repo_url"] },
  },
  { name: "list_files", description: "", dangerous: false, parameters: { type: "object", properties: { path: {} } } },
];

const def = (startConfig: Record<string, unknown>): WorkflowDefinition =>
  ({
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start", config: startConfig } },
      {
        id: "repo_fetch_agent",
        type: "agent",
        position: { x: 0, y: 0 },
        data: {
          label: "Fetch",
          config: {
            kind: "scripted",
            tools: ["git_clone"],
            user_prompt: "Requirement: {{input.requirement}}",
            steps: [
              {
                tool: "git_clone",
                args: { repo_url: { ref: "input.repo_url" }, ref: { ref: "input.repo_ref" }, path: { ref: "input.work_path" } },
              },
            ],
          },
        },
      },
      { id: "list", type: "tool", position: { x: 0, y: 0 }, data: { label: "List", config: { tool: "list_files", args: { path: { ref: "input.work_path" } } } } },
      { id: "end", type: "end", position: { x: 0, y: 0 }, data: { label: "End", config: {} } },
    ],
    edges: [],
    settings: { max_loop_iterations: 5, max_total_steps: 100, max_duration_seconds: 3600 },
  }) as unknown as WorkflowDefinition;

describe("runInputSpec", () => {
  it("prefills required inputs bound to required tool arguments", () => {
    const spec = runInputSpec(def({ default_input: {} }), tools);
    expect(spec.required).toEqual(["repo_url"]);
    expect(spec.optional).toEqual(["repo_ref", "requirement", "work_path"]);
    expect(spec.prefill).toEqual({ repo_url: "" });
  });

  it("keeps start default_input values and input_schema requirements", () => {
    const spec = runInputSpec(
      def({ default_input: { repo_url: "https://github.com/o/r", work_path: "repo" }, input_schema: { required: ["ticket"] } }),
      tools,
    );
    expect(spec.required).toEqual(["repo_url", "ticket"]);
    expect(spec.prefill).toEqual({ repo_url: "https://github.com/o/r", work_path: "repo", ticket: "" });
  });

  it("reports blank or missing required inputs", () => {
    const spec = runInputSpec(def({}), tools);
    expect(missingRequired(spec, {})).toEqual(["repo_url"]);
    expect(missingRequired(spec, { repo_url: "  " })).toEqual(["repo_url"]);
    expect(missingRequired(spec, { repo_url: "https://github.com/o/r" })).toEqual([]);
  });

  it("works before tools have loaded", () => {
    const spec = runInputSpec(def({}), []);
    expect(spec.required).toEqual([]);
    expect(spec.optional).toContain("repo_url");
  });
});
