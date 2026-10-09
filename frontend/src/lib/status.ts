import type { ApprovalStatus, NodeRunStatus, RunStatus } from "@/types";

export type Tone = "muted" | "info" | "success" | "destructive" | "warning" | "secondary";

const RUN_TONE: Record<RunStatus, Tone> = {
  PENDING: "muted",
  RUNNING: "info",
  PAUSED: "secondary",
  WAITING_APPROVAL: "warning",
  COMPLETED: "success",
  FAILED: "destructive",
  CANCELLED: "muted",
};

const NODE_TONE: Record<NodeRunStatus, Tone> = {
  PENDING: "muted",
  QUEUED: "info",
  RUNNING: "info",
  COMPLETED: "success",
  FAILED: "destructive",
  SKIPPED: "muted",
  WAITING: "warning",
  CANCELLED: "muted",
};

const APPROVAL_TONE: Record<ApprovalStatus, Tone> = {
  pending: "warning",
  approved: "success",
  rejected: "destructive",
  cancelled: "muted",
};

export function toneFor(status: string | null | undefined): Tone {
  if (!status) return "muted";
  if (status in RUN_TONE) return RUN_TONE[status as RunStatus];
  if (status in NODE_TONE) return NODE_TONE[status as NodeRunStatus];
  if (status in APPROVAL_TONE) return APPROVAL_TONE[status as ApprovalStatus];
  return "muted";
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "Never run";
  const s = status.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const TERMINAL_RUN_STATUSES: RunStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];
export function isTerminal(status: RunStatus | string | null | undefined): boolean {
  return !!status && (TERMINAL_RUN_STATUSES as string[]).includes(status);
}
