import { useId } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Label + control + hint/error, wiring ids for accessibility. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  id: idProp,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  children: (id: string) => React.ReactNode;
  className?: string;
  id?: string;
}) {
  const gen = useId();
  const id = idProp ?? gen;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Number input helper: empty string -> null. */
export function numOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
