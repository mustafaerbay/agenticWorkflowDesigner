import { Ban, CheckCircle2, CircleDashed, Clock, Loader2, PauseCircle, ShieldAlert, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { statusLabel, toneFor } from "@/lib/status";
import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  RUNNING: Loader2,
  QUEUED: Clock,
  PENDING: CircleDashed,
  PAUSED: PauseCircle,
  WAITING_APPROVAL: ShieldAlert,
  WAITING: ShieldAlert,
  COMPLETED: CheckCircle2,
  FAILED: XCircle,
  CANCELLED: Ban,
  SKIPPED: CircleDashed,
  pending: ShieldAlert,
  approved: CheckCircle2,
  rejected: XCircle,
  cancelled: Ban,
};

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const tone = toneFor(status);
  const Icon = status ? ICONS[status] : undefined;
  return (
    <Badge variant={tone} className={cn(className)}>
      {Icon && <Icon className={cn(status === "RUNNING" && "animate-spin")} />}
      {statusLabel(status)}
    </Badge>
  );
}
