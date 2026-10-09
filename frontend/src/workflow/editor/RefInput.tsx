import { useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Text input with an accessible autocomplete listbox for reference paths. */
export function RefInput({
  value,
  onChange,
  suggestions,
  placeholder = "node_id.output.field",
  className,
  "aria-label": ariaLabel,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const list = q ? suggestions.filter((s) => s.toLowerCase().includes(q) && s !== value) : suggestions;
    return list.slice(0, 12);
  }, [value, suggestions]);

  const pick = (s: string) => {
    onChange(s);
    setActive(0);
    // keep open when picking a prefix like "agent.output." so the user can keep typing
    setOpen(s.endsWith("."));
    inputRef.current?.focus();
  };

  return (
    <div className={cn("relative", className)}>
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded={open && filtered.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        spellCheck={false}
        className="h-8 font-mono text-xs"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || filtered.length === 0) {
            if (e.key === "ArrowDown") setOpen(true);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => (a + 1) % filtered.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a - 1 + filtered.length) % filtered.length);
          } else if (e.key === "Enter") {
            const s = filtered[active];
            if (s) {
              e.preventDefault();
              pick(s);
            }
          } else if (e.key === "Escape" || e.key === "Tab") {
            setOpen(false);
          }
        }}
      />
      {open && filtered.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-auto rounded-md border bg-popover p-1 shadow-lg"
        >
          {filtered.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === active}
              className={cn(
                "cursor-pointer truncate rounded px-2 py-1 font-mono text-[11px]",
                i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
