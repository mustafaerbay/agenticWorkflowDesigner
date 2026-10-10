import { useState } from "react";
import { ChevronDown, ChevronRight, ShieldCheck, UserCheck } from "lucide-react";
import { authorizationPhrase, isSensitive, sideEffectLabel } from "@/business/labels";
import { cn } from "@/lib/utils";
import type { BusinessNodeInfo, NodeType } from "@/types";
import { NODE_META } from "@/workflow/nodeMeta";
import { businessSubtitle } from "@/workflow/nodes/WorkflowNodes";
import type { FlowNodeData } from "@/workflow/types";
import { PolicyBadge, SeparationOfDutiesBadge } from "./Pills";

const FALLBACK_WHAT: Record<NodeType, string> = {
  start: "Where the workflow begins.",
  agent: "An AI step that reads the information it is given and produces a result.",
  condition: "Chooses which way the workflow continues, based on rules.",
  tool: "Runs an action in an app.",
  parallel: "Starts several paths at the same time.",
  join: "Waits until the paths running at the same time are finished.",
  approval: "Pauses until a person approves or rejects.",
  delay: "Waits for a while before continuing.",
  end: "The workflow finishes successfully.",
  fail: "The workflow stops and is marked as failed.",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** "What this step does" panel shown in business mode, with technical details tucked away. */
export function BusinessNodeDetails({
  type,
  data,
  technical,
  technicalOpenByDefault = false,
}: {
  type: NodeType;
  data: Pick<FlowNodeData, "label" | "business" | "config" | "description">;
  /** The existing technical config form. */
  technical?: React.ReactNode;
  technicalOpenByDefault?: boolean;
}) {
  const [open, setOpen] = useState(technicalOpenByDefault);
  const b: BusinessNodeInfo | undefined = data.business;
  const meta = NODE_META[type];
  const Icon = meta.icon;
  const needs = b?.needs ?? [];
  const produces = b?.produces ?? [];
  const sensitive = isSensitive(b?.side_effect);
  const personActs = b?.requires_action ?? type === "approval";
  return (
    <div className="space-y-4" data-testid="business-node-details">
      <div className="flex items-start gap-2.5">
        <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", meta.accent)}>
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{b?.title || data.label}</h3>
          <p className="text-[11px] text-muted-foreground">{businessSubtitle(type, data)}</p>
        </div>
      </div>
      {(b?.policy_inserted || b?.separation_of_duties) && (
        <div className="flex flex-wrap gap-1.5">
          {b?.policy_inserted && <PolicyBadge />}
          {b?.separation_of_duties && <SeparationOfDutiesBadge />}
        </div>
      )}
      {b?.policy_inserted && (
        <p className="rounded-md border border-info/30 bg-info/10 px-2.5 py-2 text-xs">
          This step was added automatically because company policy requires a person to approve before the workflow sends
          messages, changes data in other systems or performs financial actions.
        </p>
      )}
      <dl className="space-y-3">
        <Row label="What this step does">{b?.description || data.description || FALLBACK_WHAT[type]}</Row>
        <Row label="What it needs">
          {needs.length === 0 ? (
            <span className="text-muted-foreground">Nothing specific</span>
          ) : (
            <ul className="space-y-0.5">
              {needs.map((n, i) => (
                <li key={i}>
                  <span className="font-medium">{n.label}</span>
                  {n.value && <span className="text-muted-foreground"> — {n.value}</span>}
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="What it produces">
          {produces.length === 0 ? <span className="text-muted-foreground">Nothing specific</span> : produces.join(", ")}
        </Row>
        <Row label="Which application it uses">{b?.app || b?.connector_label || <span className="text-muted-foreground">None — runs inside this platform</span>}</Row>
        {b?.side_effect && b.side_effect !== "none" && <Row label="Effect">{sideEffectLabel(b.side_effect)}</Row>}
        <Row label="Does a person need to act?">
          {personActs ? (
            <span className="flex items-center gap-1.5">
              <UserCheck className="size-4 text-amber-600 dark:text-warning" aria-hidden /> Yes — someone must approve or reject
            </span>
          ) : (
            "No"
          )}
        </Row>
        {sensitive && (
          <Row label="Authorization">
            <span className="flex items-start gap-1.5">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
              When enabling the workflow you must authorize it to {authorizationPhrase(b?.side_effect, b?.app)}.
            </span>
          </Row>
        )}
      </dl>
      {technical && (
        <div className="border-t pt-3">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
            Technical details
          </button>
          {open && <div className="mt-3 space-y-4">{technical}</div>}
        </div>
      )}
    </div>
  );
}
