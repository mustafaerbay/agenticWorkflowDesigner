import { createContext, useContext } from "react";
import { useUiStore } from "@/stores/ui";

export type NodeDisplayMode = "business" | "advanced";

/** Force a display mode for a subtree (e.g. the builder preview is always business). */
export const NodeDisplayContext = createContext<NodeDisplayMode | null>(null);

/** The effective node display mode: a forced mode from context, else the persisted Advanced toggle. */
export function useNodeDisplayMode(): NodeDisplayMode {
  const forced = useContext(NodeDisplayContext);
  const advanced = useUiStore((s) => s.advancedMode);
  return forced ?? (advanced ? "advanced" : "business");
}
