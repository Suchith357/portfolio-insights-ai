import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Brain,
  Briefcase,
  ChartCandlestick,
  Eye,
  Gauge,
  LayoutDashboard,
  LineChart,
  LogOut,
  Menu,
  Shield,
  User as UserIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarketDataBadge } from "@/components/common/data-display";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/portfolios", label: "Portfolios", icon: Briefcase },
  { to: "/stocks", label: "Stocks", icon: ChartCandlestick },
  { to: "/intelligence", label: "Intelligence", icon: Brain },
  { to: "/risk", label: "Risk Diagnosis", icon: Gauge },
  { to: "/watchlist", label: "Watchlist", icon: Eye },
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/profile", label: "Profile", icon: UserIcon },
] as const;

function Brand() {
  return (
    <Link to="/dashboard" className="flex items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
        <LineChart className="h-4 w-4" aria-hidden />
      </span>
      <span className="text-sm font-semibold tracking-tight">
        Portfolio<span className="text-primary">IQ</span>
      </span>
    </Link>
  );
}

function NavLinks({ isAdmin, onNavigate }: { isAdmin: boolean; onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const items = [...NAV, ...(isAdmin ? [{ to: "/admin", label: "Admin", icon: Shield } as const] : [])];
  return (
    <nav className="space-y-1">
      {items.map(({ to, label, icon: Icon }) => {
        const active = pathname === to || pathname.startsWith(`${to}/`);
        return (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-primary/12 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  async function handleLogout() {
    await logout();
    navigate({ to: "/login", replace: true });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border bg-surface p-4 lg:flex">
        <Brand />
        <div className="mt-6 flex-1">
          <NavLinks isAdmin={isAdmin} />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Analytics are computed from stored market data (Yahoo Finance sync).
        </p>
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-background/80" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <Brand />
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close menu">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-6 flex-1">
              <NavLinks isAdmin={isAdmin} onNavigate={() => setOpen(false)} />
            </div>
          </aside>
        </div>
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </Button>
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-3">
            <MarketDataBadge className="hidden sm:inline-flex" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-full p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="bg-primary/15 text-xs text-primary">
                      {initials(user?.name ?? "PortfolioIQ")}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="text-sm font-medium">{user?.name}</p>
                  <p className="text-xs font-normal text-muted-foreground">{user?.email}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-primary">{user?.role}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/profile">Profile settings</Link>
                </DropdownMenuItem>
                {isAdmin && (
                  <DropdownMenuItem asChild>
                    <Link to="/admin">Admin console</Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void handleLogout()}>
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-6">{children}</main>
      </div>
    </div>
  );
}

export function PagePlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="panel mt-4 p-8 text-sm text-muted-foreground">
        This section is part of PortfolioIQ and is being built next. The route, navigation and access rules are already
        in place.
      </div>
    </div>
  );
}
