import { AlertTriangle, CheckCircle2, Info, Lock, ShieldCheck, Users, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { capabilityStatus, FINDING_META, workflowStatusLabel } from "@/business/labels";
import { cn } from "@/lib/utils";
import type { CapabilityStatus, Finding, WorkflowSummary } from "@/types";

export function CapabilityStatusBadge({ status, className }: { status: CapabilityStatus | string | null | undefined; className?: string }) {
  const s = capabilityStatus(status);
  const Icon = s.tone === "success" ? CheckCircle2 : s.tone === "destructive" ? XCircle : s.tone === "warning" ? AlertTriangle : Info;
  return (
    <Badge variant={s.tone} className={className} title={s.description}>
      <Icon aria-hidden /> {s.label}
    </Badge>
  );
}

export function WorkflowStatusBadge({ wf, className }: { wf: Pick<WorkflowSummary, "status" | "enabled_version">; className?: string }) {
  const s = workflowStatusLabel(wf);
  return (
    <Badge variant={s.tone} className={className} data-testid="workflow-status">
      {s.label}
    </Badge>
  );
}

export function PolicyBadge({ className }: { className?: string }) {
  return (
    <Badge variant="info" className={className} title="Added automatically because company policy requires it">
      <ShieldCheck aria-hidden /> Required by policy
    </Badge>
  );
}

export function SeparationOfDutiesBadge({ className }: { className?: string }) {
  return (
    <Badge variant="warning" className={className} title="The approver must be a different person from whoever started the run">
      <Users aria-hidden /> Different approver required
    </Badge>
  );
}

export function DepartmentBadge({ name, sensitive, className }: { name: string; sensitive?: boolean; className?: string }) {
  return (
    <Badge variant="outline" className={className}>
      {sensitive && <Lock aria-hidden />}
      {name}
    </Badge>
  );
}

export function FindingsList({ findings, className, empty }: { findings: Finding[]; className?: string; empty?: string }) {
  if (findings.length === 0) return empty ? <p className={cn("text-xs text-muted-foreground", className)}>{empty}</p> : null;
  return (
    <ul className={cn("space-y-1.5", className)}>
      {findings.map((f, i) => {
        const meta = FINDING_META[f.severity] ?? FINDING_META.info;
        return (
          <li
            key={`${f.code}-${i}`}
            className={cn(
              "flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs",
              f.severity === "error" && "border-destructive/30 bg-destructive/5",
              (f.severity === "setup" || f.severity === "warning") && "border-warning/40 bg-warning/10",
            )}
          >
            <Badge variant={meta.tone} className="mt-px shrink-0">
              {meta.label}
            </Badge>
            <span className="min-w-0">{f.message}</span>
          </li>
        );
      })}
    </ul>
  );
}
