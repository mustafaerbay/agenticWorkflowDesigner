import {
  Bot,
  Clock,
  Flag,
  GitBranch,
  GitFork,
  GitMerge,
  Play,
  ShieldCheck,
  Wrench,
  XOctagon,
  type LucideIcon,
} from "lucide-react";
import type {
  AgentNodeConfig,
  AnyNodeConfig,
  ConditionNodeConfig,
  NodeConfigByType,
  NodeType,
  WorkflowSettings,
} from "@/types";

export type PaletteCategory =
  | "Triggers"
  | "AI Agents"
  | "Conditions"
  | "Control Flow"
  | "Tools"
  | "Human Interaction"
  | "Outputs";

export const PALETTE_CATEGORIES: PaletteCategory[] = [
  "Triggers",
  "AI Agents",
  "Conditions",
  "Control Flow",
  "Tools",
  "Human Interaction",
  "Outputs",
];

export interface NodeMeta {
  type: NodeType;
  title: string;
  description: string;
  icon: LucideIcon;
  category: PaletteCategory;
  /** Tailwind classes for the colored accent (icon chip). */
  accent: string;
  /** Raw color for minimap. */
  color: string;
  hasTarget: boolean;
}

export const NODE_META: Record<NodeType, NodeMeta> = {
  start: {
    type: "start",
    title: "Start",
    description: "Entry point of the workflow",
    icon: Play,
    category: "Triggers",
    accent: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    color: "#10b981",
    hasTarget: false,
  },
  agent: {
    type: "agent",
    title: "AI Agent",
    description: "Run an LLM-powered or scripted Python agent",
    icon: Bot,
    category: "AI Agents",
    accent: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
    color: "#6366f1",
    hasTarget: true,
  },
  condition: {
    type: "condition",
    title: "Condition",
    description: "Branch on structured rules",
    icon: GitBranch,
    category: "Conditions",
    accent: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    color: "#f59e0b",
    hasTarget: true,
  },
  tool: {
    type: "tool",
    title: "Tool",
    description: "Invoke an approved tool",
    icon: Wrench,
    category: "Tools",
    accent: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    color: "#0ea5e9",
    hasTarget: true,
  },
  parallel: {
    type: "parallel",
    title: "Parallel",
    description: "Fan out to all outgoing branches",
    icon: GitFork,
    category: "Control Flow",
    accent: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    color: "#8b5cf6",
    hasTarget: true,
  },
  join: {
    type: "join",
    title: "Join",
    description: "Synchronize parallel branches",
    icon: GitMerge,
    category: "Control Flow",
    accent: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    color: "#8b5cf6",
    hasTarget: true,
  },
  delay: {
    type: "delay",
    title: "Delay",
    description: "Wait for a period of time",
    icon: Clock,
    category: "Control Flow",
    accent: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
    color: "#64748b",
    hasTarget: true,
  },
  approval: {
    type: "approval",
    title: "Approval",
    description: "Pause until a human approves or rejects",
    icon: ShieldCheck,
    category: "Human Interaction",
    accent: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
    color: "#eab308",
    hasTarget: true,
  },
  end: {
    type: "end",
    title: "End",
    description: "Successful termination",
    icon: Flag,
    category: "Outputs",
    accent: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    color: "#10b981",
    hasTarget: true,
  },
  fail: {
    type: "fail",
    title: "Fail",
    description: "Terminate the workflow as failed",
    icon: XOctagon,
    category: "Outputs",
    accent: "bg-red-500/15 text-red-600 dark:text-red-400",
    color: "#ef4444",
    hasTarget: true,
  },
};

export const DEFAULT_SETTINGS: WorkflowSettings = {
  max_loop_iterations: 5,
  max_total_steps: 100,
  max_duration_seconds: 3600,
};

export function defaultAgentConfig(): AgentNodeConfig {
  return {
    agent_id: null,
    kind: "llm",
    preset: null,
    system_prompt: "",
    user_prompt: "",
    model_provider_id: null,
    model: null,
    temperature: 0.2,
    max_tokens: 2048,
    tools: [],
    timeout_seconds: 300,
    max_steps: 8,
    retry: { max_attempts: 1, backoff_seconds: 2 },
    input_mapping: {},
    output_schema: null,
    steps: [],
  };
}

export function defaultConditionConfig(): ConditionNodeConfig {
  return {
    branches: [
      {
        handle: "true",
        label: "True",
        rule: { op: "and", rules: [{ op: "eq", left: { ref: "" }, right: { value: true } }] },
      },
    ],
    default_handle: "false",
  };
}

export function defaultConfig<T extends NodeType>(type: T): NodeConfigByType[T] {
  const configs: { [K in NodeType]: () => NodeConfigByType[K] } = {
    start: () => ({ default_input: {} }),
    agent: defaultAgentConfig,
    condition: defaultConditionConfig,
    tool: () => ({ tool: "", args: {} }),
    parallel: () => ({}),
    join: () => ({ mode: "all" }),
    approval: () => ({ title: "Approval required", description: "" }),
    delay: () => ({ seconds: 5 }),
    end: () => ({}),
    fail: () => ({ message: "" }),
  };
  return configs[type]();
}

export interface HandleInfo {
  id: string;
  label: string;
  /** visual tone of the handle label */
  tone?: "default" | "success" | "danger" | "muted";
}

/** Source handles for a node type + config (per docs/contracts.md). */
export function sourceHandles(type: NodeType, config: AnyNodeConfig | undefined): HandleInfo[] {
  switch (type) {
    case "end":
    case "fail":
      return [];
    case "approval":
      return [
        { id: "approved", label: "Approved", tone: "success" },
        { id: "rejected", label: "Rejected", tone: "danger" },
      ];
    case "condition": {
      const c = (config ?? defaultConditionConfig()) as ConditionNodeConfig;
      const branches = (c.branches ?? []).map((b) => ({ id: b.handle, label: b.label || b.handle }));
      return [...branches, { id: c.default_handle || "default", label: labelForDefault(c), tone: "muted" as const }];
    }
    default:
      return [{ id: "out", label: "" }];
  }
}

function labelForDefault(c: ConditionNodeConfig): string {
  const h = c.default_handle || "default";
  if (h === "false") return "False";
  if (h === "default") return "Default";
  if (h === "otherwise") return "Otherwise";
  return `${h} (default)`;
}

/** Label to render on an edge from a given source handle (condition / approval only). */
export function handleLabel(type: NodeType | undefined, config: AnyNodeConfig | undefined, handle: string | null | undefined): string | undefined {
  if (!type || !handle) return undefined;
  if (handle === "error" && (type === "agent" || type === "tool")) return "If it fails";
  if (type !== "condition" && type !== "approval") return undefined;
  const h = sourceHandles(type, config).find((x) => x.id === handle);
  return h?.label || handle;
}

/** Agent and tool nodes also have an "error" handle, taken only after retries are exhausted. */
export function hasErrorHandle(type: NodeType): boolean {
  return type === "agent" || type === "tool";
}

export function isMultiHandle(type: NodeType): boolean {
  return type === "condition" || type === "approval";
}
