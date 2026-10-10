import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation, useMatches, useNavigate } from "react-router-dom";
import {
  Bot,
  Cpu,
  History,
  Inbox,
  LayoutDashboard,
  LayoutTemplate,
  Plug,
  Users,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/ThemeToggle";
import { api, queryKeys } from "@/services/api";
import { unreadCount, useInbox } from "@/services/queries";
import { useAuthStore } from "@/stores/auth";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  badge?: "approvals" | "inbox";
  adminOnly?: boolean;
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Build",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
      { to: "/workflows", label: "Workflows", icon: Workflow },
      { to: "/templates", label: "Templates", icon: LayoutTemplate },
      { to: "/agents", label: "Agents", icon: Bot },
    ],
  },
  {
    section: "Operate",
    items: [
      { to: "/executions", label: "Executions", icon: History },
      { to: "/approvals", label: "Approvals", icon: ShieldCheck, badge: "approvals" },
      { to: "/inbox", label: "Inbox", icon: Inbox, badge: "inbox" },
    ],
  },
  {
    section: "Configure",
    items: [
      { to: "/settings/models", label: "Model Settings", icon: Cpu },
      { to: "/settings/connections", label: "Connections", icon: Plug, adminOnly: true },
      { to: "/settings/users", label: "Users", icon: Users, adminOnly: true },
    ],
  },
];

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Workflow className="size-4" aria-hidden />
      </div>
      {!collapsed && (
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight">Agentic SDLC</p>
          <p className="text-[10px] text-muted-foreground">Workflow platform</p>
        </div>
      )}
    </div>
  );
}

function SidebarNav({
  collapsed,
  pending,
  unread,
  onNavigate,
}: {
  collapsed: boolean;
  pending: number;
  unread: number;
  onNavigate?: () => void;
}) {
  const admin = useAuthStore((s) => s.user?.role === "admin");
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.adminOnly || admin) }));
  return (
    <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-3" aria-label="Main">
      {groups.map((group) => (
        <div key={group.section}>
          {!collapsed && (
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">{group.section}</p>
          )}
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = item.icon;
              const count = item.badge === "approvals" ? pending : item.badge === "inbox" ? unread : 0;
              const badge = count > 0 ? count : null;
              const link = (
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  aria-label={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    cn(
                      "relative flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
                      isActive
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      collapsed && "justify-center px-0",
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                  {badge != null && (
                    <span
                      className={cn(
                        "rounded-full bg-warning px-1.5 text-[10px] font-semibold leading-4 text-black",
                        collapsed ? "absolute -right-0.5 -top-0.5" : "ml-auto",
                      )}
                      aria-label={item.badge === "inbox" ? `${badge} unread` : `${badge} pending`}
                    >
                      {badge}
                    </span>
                  )}
                </NavLink>
              );
              return <li key={item.to}>{collapsed ? <Tooltip content={item.label} side="right">{link}</Tooltip> : link}</li>;
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const initials = (user?.name || user?.email || "?").slice(0, 2).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn("flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-accent", collapsed && "justify-center")}
          aria-label="Account menu"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[11px] font-semibold text-white">
            {initials}
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{user?.name ?? "Signed in"}</span>
              <span className="block truncate text-[10px] text-muted-foreground">{user?.role}</span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            logout();
            navigate("/login");
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppLayout() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);
  const [mobileOpen, setMobileOpen] = useState(false);
  const loc = useLocation();
  const matches = useMatches();
  const fullBleed = matches.some((m) => (m.handle as { fullBleed?: boolean } | undefined)?.fullBleed);
  const setUser = useAuthStore((s) => s.setUser);

  const approvals = useQuery({
    queryKey: queryKeys.approvals("pending"),
    queryFn: () => api.listApprovals("pending"),
    refetchInterval: 30_000,
  });
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.me, staleTime: 300_000 });
  useEffect(() => {
    if (me.data) setUser(me.data);
  }, [me.data, setUser]);
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  const pending = approvals.data?.length ?? 0;
  const inbox = useInbox();
  const unread = unreadCount(inbox.data);

  return (
    <div className="flex h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200 md:flex",
          collapsed ? "w-14" : "w-56",
        )}
      >
        <div className={cn("flex h-12 items-center border-b px-2", collapsed ? "justify-center" : "justify-between")}>
          <Logo collapsed={collapsed} />
          {!collapsed && (
            <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label="Collapse sidebar">
              <PanelLeftClose />
            </Button>
          )}
        </div>
        <SidebarNav collapsed={collapsed} pending={pending} unread={unread} />
        <div className={cn("space-y-1 border-t p-2", collapsed && "flex flex-col items-center")}>
          {collapsed && (
            <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label="Expand sidebar">
              <PanelLeftOpen />
            </Button>
          )}
          <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
            <div className="min-w-0 flex-1">
              <UserMenu collapsed={collapsed} />
            </div>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-sidebar shadow-xl animate-fade-in">
            <div className="flex h-12 items-center border-b px-3">
              <Logo collapsed={false} />
            </div>
            <SidebarNav collapsed={false} pending={pending} unread={unread} onNavigate={() => setMobileOpen(false)} />
            <div className="flex items-center gap-1 border-t p-2">
              <div className="min-w-0 flex-1">
                <UserMenu collapsed={false} />
              </div>
              <ThemeToggle />
            </div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3 md:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <Logo collapsed={false} />
        </div>
        <main id="main" className={cn("min-h-0 flex-1", fullBleed ? "overflow-hidden" : "overflow-y-auto")}>
          {fullBleed ? (
            <Outlet />
          ) : (
            <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
