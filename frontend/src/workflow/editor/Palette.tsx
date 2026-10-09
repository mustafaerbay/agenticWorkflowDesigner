import { memo, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronsLeft, ChevronsRight, Search, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePresets, useAgents, useTools } from "@/services/queries";
import { cn } from "@/lib/utils";
import type { AgentNodeConfig, AnyNodeConfig, NodeType } from "@/types";
import { defaultAgentConfig, defaultConfig, NODE_META, PALETTE_CATEGORIES, type PaletteCategory } from "../nodeMeta";
import type { NewNodeSpec } from "./store";

export const DND_MIME = "application/x-agentic-node";

export interface PaletteItem {
  key: string;
  title: string;
  description: string;
  icon: LucideIcon;
  accent: string;
  category: PaletteCategory;
  spec: NewNodeSpec;
  badge?: string;
}

function baseItem(type: NodeType): PaletteItem {
  const m = NODE_META[type];
  return {
    key: type,
    title: m.title,
    description: m.description,
    icon: m.icon,
    accent: m.accent,
    category: m.category,
    spec: { type },
  };
}

export function usePaletteItems(): PaletteItem[] {
  const presets = usePresets();
  const agents = useAgents();
  const tools = useTools();
  return useMemo(() => {
    const items: PaletteItem[] = [baseItem("start"), baseItem("agent")];
    for (const p of presets.data ?? []) {
      const config: AgentNodeConfig = { ...defaultAgentConfig(), ...p.config, agent_id: null, preset: p.key };
      items.push({
        key: `preset:${p.key}`,
        title: p.name,
        description: p.description,
        icon: Bot,
        accent: NODE_META.agent.accent,
        category: "AI Agents",
        badge: "preset",
        spec: { type: "agent", label: p.name, config, idBase: p.key.endsWith("agent") ? p.key : `${p.key}_agent`, preferBareId: true },
      });
    }
    for (const a of agents.data ?? []) {
      // Registry agent: only reference it; null fields inherit from the registry.
      const config: AgentNodeConfig = {
        agent_id: a.id,
        kind: a.kind,
        preset: a.preset ?? null,
        input_mapping: {},
      };
      items.push({
        key: `agent:${a.id}`,
        title: a.name,
        description: a.description || "Registry agent",
        icon: Bot,
        accent: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
        category: "AI Agents",
        badge: "registry",
        spec: { type: "agent", label: a.name, config, idBase: a.name, preferBareId: true },
      });
    }
    items.push(baseItem("condition"), baseItem("parallel"), baseItem("join"), baseItem("delay"));
    items.push(baseItem("tool"));
    for (const t of tools.data ?? []) {
      items.push({
        key: `tool:${t.name}`,
        title: t.name,
        description: t.description,
        icon: NODE_META.tool.icon,
        accent: NODE_META.tool.accent,
        category: "Tools",
        badge: t.dangerous ? "dangerous" : undefined,
        spec: {
          type: "tool",
          label: t.name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
          config: { ...defaultConfig("tool"), tool: t.name } as AnyNodeConfig,
          idBase: t.name,
          preferBareId: true,
        },
      });
    }
    items.push(baseItem("approval"), baseItem("end"), baseItem("fail"));
    return items;
  }, [presets.data, agents.data, tools.data]);
}

const PaletteEntry = memo(function PaletteEntry({ item, onAdd }: { item: PaletteItem; onAdd: (spec: NewNodeSpec) => void }) {
  const Icon = item.icon;
  return (
    <li>
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_MIME, JSON.stringify(item.spec));
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => onAdd(item.spec)}
        className="group flex w-full cursor-grab items-center gap-2.5 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-card active:cursor-grabbing"
        aria-label={`Add ${item.title} node`}
        title={item.description}
        data-testid={`palette-${item.key}`}
      >
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", item.accent)}>
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium">{item.title}</span>
            {item.badge && (
              <span
                className={cn(
                  "rounded px-1 text-[9px] font-medium uppercase",
                  item.badge === "dangerous" ? "bg-warning/20 text-amber-700 dark:text-warning" : "bg-muted text-muted-foreground",
                )}
              >
                {item.badge}
              </span>
            )}
          </span>
          <span className="block truncate text-[10px] text-muted-foreground">{item.description}</span>
        </span>
      </button>
    </li>
  );
});

export function Palette({
  collapsed,
  onToggle,
  onAdd,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onAdd: (spec: NewNodeSpec) => void;
}) {
  const items = usePaletteItems();
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter((i) => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
      : items;
    return PALETTE_CATEGORIES.map((c) => ({ category: c, items: filtered.filter((i) => i.category === c) })).filter(
      (g) => g.items.length > 0,
    );
  }, [items, query]);

  if (collapsed) {
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2" aria-label="Node palette">
        <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label="Expand node palette">
          <ChevronsRight />
        </Button>
        {(["start", "agent", "condition", "tool", "parallel", "join", "approval", "end"] as NodeType[]).map((t) => {
          const m = NODE_META[t];
          const Icon = m.icon;
          return (
            <button
              key={t}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_MIME, JSON.stringify({ type: t }));
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onAdd({ type: t })}
              className={cn("flex size-8 items-center justify-center rounded-md", m.accent)}
              aria-label={`Add ${m.title} node`}
              title={m.title}
            >
              <Icon className="size-4" aria-hidden />
            </button>
          );
        })}
      </aside>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar" aria-label="Node palette">
      <div className="flex items-center gap-1 border-b p-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            className="h-8 pl-7 text-xs"
            placeholder="Search nodes"
            aria-label="Search nodes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label="Collapse node palette">
          <ChevronsLeft />
        </Button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {grouped.map((g) => {
          const isClosed = closed[g.category] && !query;
          return (
            <div key={g.category}>
              <button
                type="button"
                className="flex w-full items-center gap-1 rounded px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                aria-expanded={!isClosed}
                onClick={() => setClosed((c) => ({ ...c, [g.category]: !c[g.category] }))}
              >
                <ChevronDown className={cn("size-3 transition-transform", isClosed && "-rotate-90")} aria-hidden />
                {g.category}
                <span className="ml-auto font-normal">{g.items.length}</span>
              </button>
              {!isClosed && (
                <ul className="space-y-0.5 pb-2">
                  {g.items.map((i) => (
                    <PaletteEntry key={i.key} item={i} onAdd={onAdd} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {grouped.length === 0 && <p className="p-3 text-center text-xs text-muted-foreground">No matching nodes.</p>}
      </div>
      <p className="border-t p-2 text-[10px] text-muted-foreground">Drag onto the canvas or click to add.</p>
    </aside>
  );
}
