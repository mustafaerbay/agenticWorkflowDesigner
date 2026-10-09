import { useEffect, useId, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn, parseJson, prettyJson } from "@/lib/utils";

/**
 * JSON textarea with parse validation. Calls onChange only with valid JSON
 * (or `emptyValue` when cleared). Keeps the raw text locally while invalid.
 */
export function JsonField<T>({
  label,
  value,
  onChange,
  emptyValue,
  rows = 6,
  hint,
  validate,
  placeholder,
  id: idProp,
}: {
  label?: string;
  value: T;
  onChange: (v: T) => void;
  emptyValue: T;
  rows?: number;
  hint?: React.ReactNode;
  validate?: (v: unknown) => string | null;
  placeholder?: string;
  id?: string;
}) {
  const genId = useId();
  const id = idProp ?? genId;
  const toText = (v: T) => (v === null || v === undefined ? "" : prettyJson(v));
  const [text, setText] = useState(() => toText(value));
  const [error, setError] = useState<string | null>(null);
  const lastEmitted = useRef<string>(JSON.stringify(value ?? null));

  // Resync when the value changes from the outside (undo, node switch...)
  useEffect(() => {
    const incoming = JSON.stringify(value ?? null);
    if (incoming !== lastEmitted.current) {
      lastEmitted.current = incoming;
      setText(toText(value));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handle = (t: string) => {
    setText(t);
    if (!t.trim()) {
      setError(null);
      lastEmitted.current = JSON.stringify(emptyValue ?? null);
      onChange(emptyValue);
      return;
    }
    const r = parseJson<T>(t);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const custom = validate?.(r.value) ?? null;
    if (custom) {
      setError(custom);
      return;
    }
    setError(null);
    lastEmitted.current = JSON.stringify(r.value ?? null);
    onChange(r.value);
  };

  return (
    <div className="space-y-1.5">
      {label && <Label htmlFor={id}>{label}</Label>}
      <Textarea
        id={id}
        rows={rows}
        spellCheck={false}
        value={text}
        placeholder={placeholder}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => handle(e.target.value)}
        className={cn("font-mono text-xs leading-relaxed")}
      />
      {error ? (
        <p id={`${id}-err`} className="text-[11px] text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export function JsonView({ value, className, empty = "No data" }: { value: unknown; className?: string; empty?: string }) {
  if (value === null || value === undefined || (typeof value === "object" && Object.keys(value as object).length === 0)) {
    return <p className="text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <pre className={cn("max-h-[50vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed", className)}>
      {prettyJson(value)}
    </pre>
  );
}
