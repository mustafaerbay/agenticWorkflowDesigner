import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "./api";

const STATIC = { staleTime: 60_000 } as const;

export const useTools = () => useQuery({ queryKey: queryKeys.tools, queryFn: api.listTools, ...STATIC });
export const useProviders = () => useQuery({ queryKey: queryKeys.providers, queryFn: api.listProviders, ...STATIC });
export const useAgents = () => useQuery({ queryKey: queryKeys.agents, queryFn: api.listAgents, ...STATIC });
export const usePresets = () => useQuery({ queryKey: queryKeys.presets, queryFn: api.listPresets, staleTime: 300_000 });
