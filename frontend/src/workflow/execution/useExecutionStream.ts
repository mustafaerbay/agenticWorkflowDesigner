import { useEffect, useRef, useState } from "react";
import { ExecutionStream, type WsStatus } from "@/services/ws";
import { useAuthStore } from "@/stores/auth";
import type { RunEvent } from "@/types";

/**
 * Subscribe to an execution's event stream. `after` is captured when `enabled`
 * becomes true (e.g. the run's last_event_seq from the REST snapshot).
 */
export function useExecutionStream(
  runId: string,
  enabled: boolean,
  after: number,
  onEvent: (e: RunEvent) => void,
): WsStatus {
  const [status, setStatus] = useState<WsStatus>("closed");
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const afterRef = useRef(after);
  afterRef.current = after;

  useEffect(() => {
    if (!enabled) return;
    const stream = new ExecutionStream({
      runId,
      after: afterRef.current,
      getToken: () => useAuthStore.getState().token,
      onEvent: (e) => handler.current(e),
      onStatus: setStatus,
    });
    stream.start();
    return () => stream.stop();
  }, [runId, enabled]);

  return status;
}
