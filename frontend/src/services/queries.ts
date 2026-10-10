import { useQuery } from "@tanstack/react-query";
import type { InboxItem } from "@/types";
import { api, queryKeys } from "./api";

const STATIC = { staleTime: 60_000 } as const;

export const useTools = () => useQuery({ queryKey: queryKeys.tools, queryFn: api.listTools, ...STATIC });
export const useProviders = () => useQuery({ queryKey: queryKeys.providers, queryFn: api.listProviders, ...STATIC });
export const useAgents = () => useQuery({ queryKey: queryKeys.agents, queryFn: api.listAgents, ...STATIC });
export const usePresets = () => useQuery({ queryKey: queryKeys.presets, queryFn: api.listPresets, staleTime: 300_000 });

export const useDepartments = () => useQuery({ queryKey: queryKeys.departments, queryFn: api.listDepartments, staleTime: 300_000 });
export const useCapabilities = (department?: string | null) =>
  useQuery({ queryKey: queryKeys.capabilities(department), queryFn: () => api.listCapabilities(department ?? undefined), ...STATIC });
export const useConnectors = () => useQuery({ queryKey: queryKeys.connectors, queryFn: api.listConnectors, staleTime: 300_000 });
export const useDesignerStatus = () => useQuery({ queryKey: queryKeys.designerStatus, queryFn: api.designerStatus, ...STATIC });
export const useInbox = () => useQuery({ queryKey: queryKeys.inbox, queryFn: api.listInbox, refetchInterval: 30_000 });

export function unreadCount(items: InboxItem[] | undefined): number {
  return (items ?? []).filter((i) => !i.done_at).length;
}
