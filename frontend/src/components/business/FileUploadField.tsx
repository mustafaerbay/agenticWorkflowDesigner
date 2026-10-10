import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileCheck2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/services/api";
import type { UploadedFile } from "@/types";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = ".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv";

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Uploads a file with POST /api/files and reports the returned file id. */
export function FileUploadField({
  id,
  value,
  onChange,
  department,
  label,
}: {
  id: string;
  /** Uploaded file id ("" when none). */
  value: string;
  onChange: (fileId: string, file: UploadedFile | null) => void;
  department?: string | null;
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadFile(file, department),
    onSuccess: (f) => {
      setUploaded(f);
      setError(null);
      onChange(f.id, f);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("The file is larger than 20 MB.");
      return;
    }
    upload.mutate(file);
  };

  const current = value && uploaded?.id === value ? uploaded : null;
  return (
    <div className="space-y-1">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        aria-label={label}
        data-testid={`file-input-${id}`}
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
          {upload.isPending ? <Spinner /> : <Paperclip />} {value ? "Replace file" : "Choose file"}
        </Button>
        {value ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <FileCheck2 className="size-4 shrink-0 text-success" aria-hidden />
            <span className="truncate">{current ? `${current.name} · ${formatSize(current.size_bytes)}` : "File attached"}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${label}`}
              onClick={() => {
                setUploaded(null);
                onChange("", null);
              }}
            >
              <X />
            </Button>
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">PDF, TXT, MD or CSV · max 20 MB</span>
        )}
      </div>
      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          Upload failed: {error}
        </p>
      )}
    </div>
  );
}
