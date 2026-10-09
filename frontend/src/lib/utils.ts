import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "ago" : "from now";
  if (abs < 45) return diff >= 0 ? "just now" : "in a moment";
  if (abs < 3600) return `${Math.round(abs / 60)}m ${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h ${suffix}`;
  return `${Math.round(abs / 86400)}d ${suffix}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function durationBetween(start: string | null | undefined, end: string | null | undefined, now: number = Date.now()): number | null {
  if (!start) return null;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : now;
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  return Math.max(0, e - s);
}

export function prettyJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseJson<T = unknown>(text: string): ParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid JSON" };
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "workflow";
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, wait: number): ((...args: A) => void) & { cancel: () => void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: A | null = null;
  const run = () => {
    last = Date.now();
    timer = null;
    const args = pendingArgs;
    pendingArgs = null;
    if (args) fn(...args);
  };
  const throttled = (...args: A) => {
    pendingArgs = args;
    const remaining = wait - (Date.now() - last);
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      run();
    } else if (!timer) {
      timer = setTimeout(run, remaining);
    }
  };
  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
  };
  return throttled;
}
