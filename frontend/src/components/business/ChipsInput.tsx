import { useState } from "react";
import { X } from "lucide-react";
import { splitList } from "@/business/inputs";

/** Comma-separated list entry rendered as removable chips. */
export function ChipsInput({
  id,
  value,
  onChange,
  placeholder,
  ariaDescribedBy,
}: {
  id: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  ariaDescribedBy?: string;
}) {
  const [draft, setDraft] = useState("");
  const commit = (text: string) => {
    const items = splitList(text).filter((x) => !value.includes(x));
    if (items.length) onChange([...value, ...items]);
    setDraft("");
  };
  return (
    <div className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-card px-2 py-1 shadow-xs focus-within:outline-2 focus-within:outline-ring">
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">
          {v}
          <button
            type="button"
            className="rounded-full text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(value.filter((x) => x !== v))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="min-w-24 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
        value={draft}
        placeholder={value.length ? "" : placeholder ?? "Type and press Enter or comma"}
        aria-describedby={ariaDescribedBy}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(",")) commit(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (draft.trim()) commit(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft.trim() && commit(draft)}
      />
    </div>
  );
}
