import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { InputValues } from "@/business/inputs";
import type { PlanInput } from "@/types";
import { FileUploadField } from "./FileUploadField";

function PlanInputField({
  input,
  value,
  onChange,
  department,
}: {
  input: PlanInput;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
  department?: string | null;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const label = (
    <>
      {input.label || input.key}
      {input.required && <span className="text-destructive"> *</span>}
    </>
  );
  if (input.type === "boolean") {
    return (
      <div className="flex items-start gap-2">
        <Checkbox id={id} checked={value === true} onCheckedChange={(c) => onChange(c === true)} aria-describedby={hintId} />
        <div className="space-y-0.5">
          <Label htmlFor={id}>{label}</Label>
          {input.description && (
            <p id={hintId} className="text-[11px] text-muted-foreground">
              {input.description}
            </p>
          )}
        </div>
      </div>
    );
  }
  const str = typeof value === "string" ? value : "";
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {input.type === "file" ? (
        <FileUploadField id={id} label={input.label || input.key} value={str} onChange={(fid) => onChange(fid)} department={department} />
      ) : (
        <Input
          id={id}
          type={input.type === "number" ? "number" : input.type === "date" ? "date" : input.type === "email" ? "email" : "text"}
          value={str}
          required={input.required}
          aria-describedby={hintId}
          placeholder={input.type === "list" ? "Separate items with commas" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {(input.description || input.type === "list") && (
        <p id={hintId} className="text-[11px] text-muted-foreground">
          {input.description || "Separate items with commas."}
        </p>
      )}
    </div>
  );
}

/** Form for a business workflow's requested information (plan inputs), including file uploads. */
export function PlanInputsForm({
  inputs,
  values,
  onChange,
  department,
}: {
  inputs: PlanInput[];
  values: InputValues;
  onChange: (next: InputValues) => void;
  department?: string | null;
}) {
  if (inputs.length === 0) return <p className="text-xs text-muted-foreground">This workflow does not ask for any information.</p>;
  return (
    <div className="space-y-3">
      {inputs.map((i) => (
        <PlanInputField
          key={i.key}
          input={i}
          value={values[i.key]}
          department={department}
          onChange={(v) => onChange({ ...values, [i.key]: v })}
        />
      ))}
    </div>
  );
}
