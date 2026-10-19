import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage, queryKeys } from "@/services/api";
import type { Workflow } from "@/types";

export const SCHEDULE_PRESETS = [
  { cron: "*/15 * * * *", label: "Every 15 minutes" },
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "0 2 * * *", label: "Every night at 02:00" },
  { cron: "0 7 * * 1-5", label: "Weekdays at 07:00" },
  { cron: "0 8 * * 1", label: "Mondays at 08:00" },
] as const;

export function describeSchedule(cron: string | null | undefined, timezone = "UTC"): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.cron === cron);
  return `${preset ? preset.label : `Custom schedule (${cron})`} · ${timezone}`;
}

/** When a business workflow runs: manually or on a schedule (editable by builders). */
export function ScheduleCard({ workflow, canEdit }: { workflow: Workflow; canEdit: boolean }) {
  const trigger = workflow.plan?.trigger;
  const scheduled = trigger?.type === "schedule";
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<"manual" | "schedule">("manual");
  const [preset, setPreset] = useState<string>("*/15 * * * *");
  const [custom, setCustom] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [skip, setSkip] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    if (!editing) return;
    setMode(scheduled ? "schedule" : "manual");
    const cron = trigger?.cron ?? "*/15 * * * *";
    const known = SCHEDULE_PRESETS.some((p) => p.cron === cron);
    setPreset(known ? cron : "custom");
    setCustom(known ? "" : cron);
    setTimezone(trigger?.timezone || "UTC");
    setSkip(trigger?.skip_if_running ?? true);
  }, [editing, scheduled, trigger]);

  const cron = preset === "custom" ? custom.trim() : preset;
  const save = useMutation({
    mutationFn: () =>
      api.setSchedule(workflow.id, mode === "manual" ? { enabled: false } : { enabled: true, cron, timezone: timezone.trim() || "UTC", skip_if_running: skip }),
    onSuccess: (wf) => {
      qc.setQueryData(queryKeys.workflow(workflow.id), wf);
      void qc.invalidateQueries({ queryKey: queryKeys.workflowsAll });
      toast.success(mode === "manual" ? "The workflow now runs only when started manually" : "Schedule saved");
      setEditing(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">Schedule</p>
              <p className="text-xs text-muted-foreground" data-testid="schedule-summary">
                {scheduled ? describeSchedule(trigger?.cron, trigger?.timezone) : "Runs only when someone starts it"}
                {scheduled && (trigger?.skip_if_running ?? true) && " · skipped while a previous run is still active"}
                {scheduled && workflow.status !== "enabled" && " · starts once the workflow is enabled"}
              </p>
            </div>
          </div>
          {canEdit && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil /> Change schedule
            </Button>
          )}
        </div>
        {editing && (
          <form
            className="space-y-3 border-t pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="flex gap-4 text-sm" role="radiogroup" aria-label="When it runs">
              <label className="flex items-center gap-1.5">
                <input type="radio" name="schedule-mode" checked={mode === "manual"} onChange={() => setMode("manual")} /> Only when started manually
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="schedule-mode" checked={mode === "schedule"} onChange={() => setMode("schedule")} /> Automatically on a schedule
              </label>
            </div>
            {mode === "schedule" && (
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_10rem]">
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-preset">How often</Label>
                  <Select id="schedule-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
                    {SCHEDULE_PRESETS.map((p) => (
                      <option key={p.cron} value={p.cron}>
                        {p.label}
                      </option>
                    ))}
                    <option value="custom">Custom (cron expression)</option>
                  </Select>
                </div>
                {preset === "custom" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="schedule-cron">Cron expression</Label>
                    <Input id="schedule-cron" className="font-mono" value={custom} placeholder="*/30 8-18 * * 1-5" onChange={(e) => setCustom(e.target.value)} />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label>Cron expression</Label>
                    <p className="pt-2 font-mono text-xs text-muted-foreground">{preset}</p>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-tz">Time zone</Label>
                  <Input id="schedule-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC" />
                </div>
                <label className="flex items-center gap-2 text-xs sm:col-span-3">
                  <Checkbox checked={skip} onCheckedChange={(c) => setSkip(c === true)} aria-label="Skip while a previous run is active" />
                  Skip a scheduled run while the previous one is still active (for example while a fix waits for review)
                </label>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={save.isPending || (mode === "schedule" && !cron)}>
                {save.isPending && <Spinner className="text-primary-foreground" />} Save schedule
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
