import { Link } from "react-router-dom";
import {
  AppWindow,
  ArrowDown,
  CheckCircle2,
  Clock,
  FileInput,
  Flag,
  GitBranch,
  ListChecks,
  Minus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authorizationPhrase, isBlocking, sideEffectLabel, stepKindLabel } from "@/business/labels";
import { diffLines } from "@/business/diff";
import { cn } from "@/lib/utils";
import type { Explanation, ExplanationStep, Finding, PlanDiff, UnmetNeed } from "@/types";
import { CapabilityStatusBadge, FindingsList, PolicyBadge, SeparationOfDutiesBadge } from "./Pills";

const KIND_ICON: Record<string, LucideIcon> = {
  action: AppWindow,
  decision: GitBranch,
  approval: ShieldCheck,
  wait: Clock,
};

const KIND_ACCENT: Record<string, string> = {
  action: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  decision: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  approval: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  wait: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
};

function Section({ title, icon: Icon, children, className }: { title: string; icon?: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2", className)}>
      <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="size-3.5" aria-hidden />} {title}
      </h4>
      {children}
    </section>
  );
}

export function StepCard({ step, index, highlight }: { step: ExplanationStep; index: number; highlight?: "added" | "changed" | null }) {
  const Icon = KIND_ICON[step.kind] ?? AppWindow;
  return (
    <article
      className={cn(
        "rounded-lg border bg-card p-3 shadow-xs",
        highlight === "added" && "border-success/60 ring-1 ring-success/30",
        highlight === "changed" && "border-info/60 ring-1 ring-info/30",
      )}
      data-testid={`step-card-${step.step_id}`}
      aria-label={`Step ${index + 1}: ${step.title}`}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md", KIND_ACCENT[step.kind] ?? KIND_ACCENT.action)}>
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium tabular-nums text-muted-foreground">{index + 1}.</span>
            <h5 className="text-sm font-semibold leading-5">{step.title}</h5>
            <Badge variant="muted">{stepKindLabel(step.kind)}</Badge>
            {step.status && step.status !== "available" && <CapabilityStatusBadge status={step.status} />}
            {step.policy_inserted && <PolicyBadge />}
            {step.separation_of_duties && <SeparationOfDutiesBadge />}
            {highlight === "added" && <Badge variant="success">New</Badge>}
            {highlight === "changed" && <Badge variant="info">Changed</Badge>}
          </div>
          {step.what && <p className="text-xs text-muted-foreground">{step.what}</p>}
          <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            {step.app && (
              <>
                <dt className="text-muted-foreground">App</dt>
                <dd>{step.app}</dd>
              </>
            )}
            {step.needs && step.needs.length > 0 && (
              <>
                <dt className="text-muted-foreground">Needs</dt>
                <dd>{step.needs.join(", ")}</dd>
              </>
            )}
            {step.produces && step.produces.length > 0 && (
              <>
                <dt className="text-muted-foreground">Produces</dt>
                <dd>{step.produces.join(", ")}</dd>
              </>
            )}
            {step.side_effect && step.side_effect !== "none" && (
              <>
                <dt className="text-muted-foreground">Effect</dt>
                <dd>{sideEffectLabel(step.side_effect)}</dd>
              </>
            )}
            {step.retry && (
              <>
                <dt className="text-muted-foreground">Retries</dt>
                <dd>{step.retry}</dd>
              </>
            )}
            {step.requires_action && (
              <>
                <dt className="text-muted-foreground">Who acts</dt>
                <dd>A person must decide</dd>
              </>
            )}
            {step.on_reject && (
              <>
                <dt className="text-muted-foreground">If rejected</dt>
                <dd>{step.on_reject}</dd>
              </>
            )}
          </dl>
          {step.rules && step.rules.length > 0 && (
            <ul className="space-y-0.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
              {step.rules.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {step.note && <p className="text-[11px] text-amber-700 dark:text-warning">{step.note}</p>}
          {step.then && <p className="text-[11px] text-muted-foreground">Then: {step.then}</p>}
        </div>
      </div>
    </article>
  );
}

export function StepCards({ explanation, diff }: { explanation: Explanation; diff?: PlanDiff | null }) {
  const added = new Set(diff?.added.map((a) => a.step_id) ?? []);
  const changed = new Set(diff?.changed.map((c) => c.step_id) ?? []);
  if (explanation.steps.length === 0) return <p className="text-xs text-muted-foreground">No steps yet.</p>;
  return (
    <ol className="space-y-2" aria-label="Workflow steps">
      {explanation.steps.map((s, i) => (
        <li key={s.step_id}>
          <StepCard step={s} index={i} highlight={added.has(s.step_id) ? "added" : changed.has(s.step_id) ? "changed" : null} />
        </li>
      ))}
    </ol>
  );
}

export function RequirementsPanel({
  explanation,
  unmetNeeds = [],
  findings,
  canConnect,
}: {
  explanation: Explanation;
  unmetNeeds?: UnmetNeed[];
  findings?: Finding[];
  /** Admins see a "Connect" link to the Connections page. */
  canConnect: boolean;
}) {
  const allFindings = findings ?? explanation.findings;
  const setup = allFindings.filter((f) => isBlocking(f.severity));
  const other = allFindings.filter((f) => !isBlocking(f.severity));
  return (
    <div className="space-y-5" data-testid="requirements">
      <Section title="Apps this workflow uses" icon={AppWindow}>
        {explanation.integrations.length === 0 ? (
          <p className="text-xs text-muted-foreground">Runs entirely inside this platform — no apps need connecting.</p>
        ) : (
          <ul className="space-y-1.5">
            {explanation.integrations.map((i) => (
              <li key={i.connector} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-xs">
                <span className="font-medium">{i.label}</span>
                <CapabilityStatusBadge status={i.status} />
                <span className="min-w-0 flex-1 text-muted-foreground">Used by: {i.steps.join(", ")}</span>
                {i.status === "requires_connection" && canConnect && (
                  <Button variant="outline" size="xs" asChild>
                    <Link to="/settings/connections">Connect</Link>
                  </Button>
                )}
                {i.status === "requires_connection" && !canConnect && (
                  <span className="text-[11px] text-muted-foreground">Ask an administrator to connect it.</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {(unmetNeeds.length > 0 || setup.length > 0) && (
        <Section title="Setup requirements" icon={ListChecks}>
          {unmetNeeds.length > 0 && (
            <ul className="space-y-1.5">
              {unmetNeeds.map((n, i) => (
                <li key={i} className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs">
                  <p className="font-medium">{n.need}</p>
                  <p className="text-muted-foreground">{n.reason}</p>
                </li>
              ))}
            </ul>
          )}
          <FindingsList findings={setup} />
        </Section>
      )}

      <Section title="What it is allowed to do" icon={ShieldCheck}>
        {explanation.permissions.length === 0 ? (
          <p className="text-xs text-muted-foreground">Only reads information — nothing is sent or changed.</p>
        ) : (
          <ul className="space-y-1.5">
            {explanation.permissions.map((p, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-xs">
                <span className="font-medium">{p.step}</span>
                <span className="text-muted-foreground">{authorizationPhrase(p.side_effect, null)}</span>
                {p.needs_authorization && <Badge variant="warning">Needs your authorization to enable</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Approvals" icon={CheckCircle2}>
        {explanation.approvals.length === 0 ? (
          <p className="text-xs text-muted-foreground">No one needs to approve anything.</p>
        ) : (
          <ul className="space-y-1.5">
            {explanation.approvals.map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-xs">
                <span className="font-medium">{a.title}</span>
                {a.policy_inserted && <PolicyBadge />}
                {a.separation_of_duties && <SeparationOfDutiesBadge />}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {other.length > 0 && (
        <Section title="Notes" icon={Flag}>
          <FindingsList findings={other} />
        </Section>
      )}
    </div>
  );
}

const DIFF_STYLE = {
  added: { cls: "border-success/40 bg-success/10", Icon: Plus, label: "Added" },
  removed: { cls: "border-destructive/30 bg-destructive/5", Icon: Minus, label: "Removed" },
  changed: { cls: "border-info/40 bg-info/10", Icon: Pencil, label: "Changed" },
  info: { cls: "border-border bg-muted/40", Icon: RefreshCw, label: "Updated" },
} as const;

export function DiffView({ diff, empty = "No changes." }: { diff: PlanDiff | null | undefined; empty?: string }) {
  const lines = diffLines(diff);
  if (lines.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1.5" data-testid="diff-view" aria-label="Proposed changes">
      {lines.map((l, i) => {
        const st = DIFF_STYLE[l.kind];
        return (
          <li key={i} className={cn("rounded-md border px-2.5 py-2 text-xs", st.cls)} data-diff-kind={l.kind}>
            <div className="flex flex-wrap items-center gap-1.5">
              <st.Icon className="size-3.5 shrink-0" aria-hidden />
              <span className="sr-only">{st.label}: </span>
              <span className="font-medium">{l.text}</span>
              {l.policy && <PolicyBadge />}
            </div>
            {l.detail && l.detail.length > 0 && (
              <ul className="mt-1 space-y-0.5 pl-5 text-muted-foreground">
                {l.detail.map((d, k) => (
                  <li key={k}>{d}</li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Full explanation: trigger, inputs, steps, integrations, permissions, approvals, outcomes, findings. */
export function ExplanationView({ explanation, canConnect }: { explanation: Explanation; canConnect: boolean }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-5">
        {explanation.summary && <p className="text-sm text-muted-foreground">{explanation.summary}</p>}
        <Section title="How it starts" icon={Play}>
          <p className="text-sm">{explanation.trigger}</p>
        </Section>
        <Section title="Information it asks for" icon={FileInput}>
          {explanation.inputs.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing — it starts without any information.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {explanation.inputs.map((i) => (
                <li key={i.key}>
                  <Badge variant="secondary">
                    {i.label}
                    {i.type === "file" ? " (file)" : ""}
                    {i.required ? "" : " · optional"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Steps" icon={ArrowDown}>
          <StepCards explanation={explanation} />
        </Section>
        <Section title="Possible outcomes" icon={Flag}>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {explanation.outcomes.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </Section>
      </div>
      <div>
        <RequirementsPanel explanation={explanation} canConnect={canConnect} />
      </div>
    </div>
  );
}
