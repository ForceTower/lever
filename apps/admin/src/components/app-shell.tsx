import {
  CaretUpDownIcon,
  CheckCircleIcon,
  FunnelIcon,
  GearIcon,
  PencilSimpleIcon,
  RocketLaunchIcon,
  SignOutIcon,
  SlidersHorizontalIcon,
  StackIcon,
} from "@phosphor-icons/react";
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { BrandLockup } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/features/auth/auth-context";
import { plural } from "@/lib/format";
import { useEnvironmentSummary, usePublishPreview } from "@/lib/queries";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/environments/$envId/parameters", label: "Parameters", icon: SlidersHorizontalIcon },
  { to: "/environments/$envId/conditions", label: "Conditions", icon: FunnelIcon },
  { to: "/environments/$envId/settings", label: "Settings", icon: GearIcon },
] as const;

const PUBLISH_ROUTE = "/environments/$envId/publish";

/** The route pattern, resolved — what the current pathname is compared against. */
function href(pattern: string, envId: string): string {
  return pattern.replace("$envId", envId);
}

/** How many parameters differ from what apps are resolving right now. */
function useDraftState(envId: string) {
  const preview = usePublishPreview(envId);
  const diff = preview.data?.diff;
  const count =
    diff === undefined ? 0 : diff.added.length + diff.removed.length + diff.changed.length;
  return { count, dirty: count > 0 };
}

function EnvironmentSwitcher({
  envId,
  open,
  onOpenChange,
}: {
  envId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { projects } = useEnvironmentSummary(envId);
  const navigate = useNavigate();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-150">
        <DialogHeader>
          <DialogTitle>Switch environment</DialogTitle>
          <DialogDescription>
            Everything below an environment is scoped to it — parameters, conditions, versions.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1.5 flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-1.5 py-0.5">
          {projects.map((project) => (
            <div key={project.id} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[12.5px] font-medium">{project.key}</span>
                <span className="text-[11.5px] text-muted-foreground">{project.name}</span>
              </div>
              {project.environments.map((environment) => (
                <button
                  key={environment.id}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    void navigate({
                      to: "/environments/$envId/parameters",
                      params: { envId: environment.id },
                    });
                  }}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left hover:bg-muted",
                    environment.id === envId && "bg-muted",
                  )}
                >
                  <span className="flex-1 font-mono text-[13px] font-medium">
                    {environment.key}
                  </span>
                  {environment.draftDirty && (
                    <Badge variant="warn" className="rounded-full text-[10.5px]">
                      unpublished
                    </Badge>
                  )}
                  <span className="font-mono text-[11px] text-muted-foreground">
                    v{environment.latestVersion}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <Button variant="outline" size="sm" className="self-start" asChild>
          <Link to="/" onClick={() => onOpenChange(false)}>
            All projects
          </Link>
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function EnvironmentPicker({ envId, compact }: { envId: string; compact?: boolean }) {
  const { project, environment } = useEnvironmentSummary(envId);
  const { dirty } = useDraftState(envId);
  const [open, setOpen] = useState(false);
  const path = project === undefined ? "…" : `${project.key} / ${environment?.key ?? ""}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-md border bg-muted px-2.5 py-2 text-left hover:bg-accent",
          // In the topbar it shares a row and takes the slack; in the sidebar
          // it is a full-width block that must not stretch down the column.
          compact ? "flex-1" : "w-full shrink-0",
        )}
      >
        {compact ? (
          <>
            <StackIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-[13px] font-medium">{path}</span>
          </>
        ) : (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[11px] text-muted-foreground">
              {project?.name ?? ""}
            </span>
            <span className="truncate font-mono text-[13px] font-medium">{path}</span>
          </span>
        )}
        {dirty && <span className="size-1.5 shrink-0 rounded-full bg-warn" />}
        <CaretUpDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      </button>
      <EnvironmentSwitcher envId={envId} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** The draft's standing, and the only way to make it live. */
function DraftStatus({ envId }: { envId: string }) {
  const { count, dirty } = useDraftState(envId);
  const { environment } = useEnvironmentSummary(envId);
  const latest = environment?.latestVersion ?? 0;
  const { can } = useAuth();

  if (!dirty) {
    return (
      <div className="flex items-center gap-2 rounded-md border p-3">
        <CheckCircleIcon className="size-4 shrink-0 text-add" />
        <p className="text-[11.5px] leading-snug text-muted-foreground">
          {latest === 0
            ? "Nothing published yet. Apps use their code defaults."
            : `Draft matches v${latest}. Nothing to publish.`}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-warn-border bg-warn-bg p-3">
      <div className="flex items-center gap-1.5 text-warn">
        <PencilSimpleIcon className="size-3.5" />
        <span className="text-[12.5px] font-semibold">{plural(count, "unpublished change")}</span>
      </div>
      <p className="text-[11.5px] leading-snug text-warn/85">
        {latest === 0
          ? "Nothing has ever been published — apps are on their code defaults."
          : `Apps are still getting v${latest}.`}
      </p>
      {can("config:publish") && (
        <Button size="sm" asChild>
          <Link to={PUBLISH_ROUTE} params={{ envId }}>
            Review &amp; publish
          </Link>
        </Button>
      )}
    </div>
  );
}

function EnvironmentSidebar({ envId, pathname }: { envId: string; pathname: string }) {
  const { environment } = useEnvironmentSummary(envId);
  const { signOut } = useAuth();
  const counts: Record<string, number | undefined> = {
    "/environments/$envId/parameters": environment?.parameterCount,
    "/environments/$envId/conditions": environment?.conditionCount,
  };

  return (
    <aside className="hidden w-66 shrink-0 flex-col gap-3.5 overflow-y-auto border-r bg-card p-3 md:flex">
      <BrandLockup className="px-1" />
      <EnvironmentPicker envId={envId} />
      <nav className="flex flex-col gap-0.5">
        {NAV.map(({ to, label, icon: ItemIcon }) => {
          const active = pathname.startsWith(href(to, envId));
          const badge = counts[to];
          return (
            <Link
              key={to}
              to={to}
              params={{ envId }}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] text-muted-foreground",
                active ? "bg-muted font-semibold text-foreground" : "font-medium hover:bg-muted/60",
              )}
            >
              <ItemIcon className="size-4" weight={active ? "fill" : "regular"} />
              <span className="flex-1">{label}</span>
              {badge !== undefined && (
                <span className="font-mono text-[11px] text-muted-foreground">{badge}</span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-2.5">
        <DraftStatus envId={envId} />
        <div className="flex gap-1.5">
          <ThemeToggle withLabel className="flex-1" />
          <Button
            variant="outline"
            size="icon-sm"
            title="Sign out"
            className="text-muted-foreground"
            onClick={() => void signOut()}
          >
            <SignOutIcon />
          </Button>
        </div>
      </div>
    </aside>
  );
}

/** The phone layout: the same destinations, plus a banner the draft cannot hide behind. */
function EnvironmentBottomNav({ envId, pathname }: { envId: string; pathname: string }) {
  const { count, dirty } = useDraftState(envId);
  const items = [...NAV, { to: PUBLISH_ROUTE, label: "Publish", icon: RocketLaunchIcon }] as const;

  return (
    <div className="shrink-0 border-t bg-card md:hidden">
      {dirty && (
        <Link
          to={PUBLISH_ROUTE}
          params={{ envId }}
          className="flex items-center gap-2.5 border-b border-warn-border bg-warn-bg px-3.5 py-2.5 text-warn"
        >
          <PencilSimpleIcon className="size-4" />
          <span className="flex-1 text-[12.5px] font-semibold">
            {plural(count, "unpublished change")} · not live
          </span>
          <span className="text-[12.5px] font-medium">Review</span>
        </Link>
      )}
      <nav className="flex items-stretch">
        {items.map(({ to, label, icon: ItemIcon }) => {
          const active = pathname.startsWith(href(to, envId));
          return (
            <Link
              key={to}
              to={to}
              params={{ envId }}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 py-2.5 text-[10.5px]",
                active ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
              )}
            >
              <ItemIcon className="size-5" weight={active ? "fill" : "regular"} />
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function AppShell() {
  const params = useParams({ strict: false });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { signOut } = useAuth();
  const envId = typeof params.envId === "string" ? params.envId : null;

  return (
    <div className="flex h-svh flex-col">
      <header
        className={cn(
          "flex shrink-0 items-center gap-2.5 border-b bg-card px-3.5 py-2.5",
          envId !== null && "md:hidden",
        )}
      >
        {envId === null ? (
          <BrandLockup className="flex-1" />
        ) : (
          <EnvironmentPicker envId={envId} compact />
        )}
        <ThemeToggle />
        {envId === null && (
          <Button
            variant="outline"
            size="icon-sm"
            title="Sign out"
            className="text-muted-foreground"
            onClick={() => void signOut()}
          >
            <SignOutIcon />
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {envId !== null && <EnvironmentSidebar envId={envId} pathname={pathname} />}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-270 flex-col gap-4.5 p-4 md:p-7">
            <Outlet />
          </div>
        </main>
      </div>

      {envId !== null && <EnvironmentBottomNav envId={envId} pathname={pathname} />}
    </div>
  );
}
