import {
  ArrowRightIcon,
  CaretRightIcon,
  ListNumbersIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/features/auth/auth-context";
import { NewParameterDialog } from "@/features/parameters/new-parameter-dialog";
import { ValueDialog } from "@/features/parameters/value-dialog";
import type { JsonValue, Parameter, SnapshotDiff } from "@/lib/api/types";
import { plural, shortValue } from "@/lib/format";
import {
  useEnvironmentSummary,
  useParameters,
  usePublishPreview,
  useUpdateParameter,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * Where a parameter stands relative to what apps are resolving. The publish
 * diff is the authority — the same comparison the server makes at publish time
 * — so a row can never claim to be live when the draft has moved on.
 */
function draftState(
  parameter: Parameter,
  diff: SnapshotDiff | undefined,
  latestVersion: number,
): { changed: boolean; label: string } {
  if (latestVersion === 0) return { changed: true, label: "draft only" };
  if (diff === undefined) return { changed: false, label: "" };
  if (diff.added.some((entry) => entry.key === parameter.key)) {
    return { changed: true, label: "new in draft" };
  }
  const edited = diff.changed.find((entry) => entry.key === parameter.key);
  if (edited !== undefined) {
    return {
      changed: true,
      label: `v${latestVersion} ${shortValue(edited.before.defaultValue, 14)} → ${shortValue(
        parameter.defaultValue,
        14,
      )}`,
    };
  }
  return { changed: false, label: `live ${shortValue(parameter.defaultValue, 18)}` };
}

export function ParametersPage() {
  const { envId } = useParams({ from: "/environments/$envId/parameters" });
  const parameters = useParameters(envId);
  const preview = usePublishPreview(envId);
  const { environment } = useEnvironmentSummary(envId);
  const { can } = useAuth();
  const update = useUpdateParameter(envId);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Parameter | null>(null);

  const latestVersion = environment?.latestVersion ?? 0;
  const diff = preview.data?.diff;
  const dirtyCount =
    diff === undefined ? 0 : diff.added.length + diff.removed.length + diff.changed.length;
  const term = query.trim().toLowerCase();
  const rows = (parameters.data ?? []).filter(
    (parameter) =>
      term === "" ||
      parameter.key.toLowerCase().includes(term) ||
      (parameter.description ?? "").toLowerCase().includes(term),
  );

  const writable = can("config:write");
  const setDefault = (parameter: Parameter, defaultValue: JsonValue) =>
    update.mutate({ id: parameter.id, patch: { defaultValue } });

  return (
    <div className="animate-lever-in flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-45 flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Parameters</h1>
          <p className="text-[13px] text-muted-foreground">
            {plural(parameters.data?.length ?? 0, "parameter")} ·{" "}
            {latestVersion === 0 ? "version 0, nothing published" : `live on v${latestVersion}`}
          </p>
        </div>
        {writable && (
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            New parameter
          </Button>
        )}
      </div>

      {dirtyCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warn-border bg-warn-bg px-3 py-3">
          <PencilSimpleIcon className="size-4 text-warn" />
          <p className="min-w-40 flex-1 text-[12.5px] leading-relaxed text-warn">
            <strong className="font-semibold">{plural(dirtyCount, "unpublished change")}</strong> —{" "}
            {latestVersion === 0
              ? "nothing has ever been published here."
              : `apps are still getting v${latestVersion}.`}
          </p>
          <Button variant="outline" size="sm" asChild className="border-warn-border text-warn">
            <Link to="/environments/$envId/publish" params={{ envId }}>
              Review diff
              <ArrowRightIcon />
            </Link>
          </Button>
        </div>
      )}

      <div className="relative">
        <MagnifyingGlassIcon className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by key or description"
          className="pl-8.5"
        />
      </div>

      {parameters.isPending && (
        <div className="overflow-hidden rounded-lg border bg-card">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-3.5 border-b p-4 last:border-b-0">
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
              <Skeleton className="h-5.5 w-11 rounded-full" />
            </div>
          ))}
        </div>
      )}

      {!parameters.isPending && rows.length === 0 && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed bg-card px-6 py-7">
          <SlidersHorizontalIcon className="size-5.5 text-muted-foreground" />
          <h2 className="text-[15px] font-semibold">
            {term === "" ? "No parameters yet" : `No parameter matches “${query}”`}
          </h2>
          <p className="max-w-[54ch] text-[13px] leading-relaxed text-muted-foreground">
            {term === ""
              ? "This environment serves nothing yet, so apps fall through to their code defaults. Create the first parameter — it stays in the draft until you publish."
              : "Nothing in this environment matches that. Clear the filter, or create the parameter."}
          </p>
          {writable && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <PlusIcon />
              New parameter
            </Button>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          {rows.map((parameter) => {
            const state = draftState(parameter, diff, latestVersion);
            return (
              <div
                key={parameter.id}
                className={cn(
                  "flex items-center gap-3 border-b border-l-3 border-l-transparent p-3.5 last:border-b-0 hover:bg-muted/50",
                  state.changed && "border-l-warn",
                )}
              >
                <Link
                  to="/environments/$envId/parameters/$parameterId"
                  params={{ envId, parameterId: parameter.id }}
                  className="flex min-w-0 flex-1 flex-col items-start gap-1.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13.5px] font-medium">{parameter.key}</span>
                    <Badge
                      variant="muted"
                      className="rounded-sm font-mono text-[10px] tracking-wider uppercase"
                    >
                      {parameter.type}
                    </Badge>
                    {state.changed && latestVersion > 0 && (
                      <Badge variant="warn" className="rounded-full text-[10.5px] font-semibold">
                        draft only
                      </Badge>
                    )}
                  </div>
                  {parameter.description !== null && parameter.description !== "" && (
                    <p className="text-[12.5px] leading-snug text-pretty text-muted-foreground">
                      {parameter.description}
                    </p>
                  )}
                  {parameter.conditionalValues.length > 0 && (
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <ListNumbersIcon className="size-3.5" />
                      {plural(parameter.conditionalValues.length, "conditional value")} · first
                      match wins
                    </span>
                  )}
                </Link>

                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {parameter.type === "boolean" ? (
                    <Switch
                      checked={parameter.defaultValue === true}
                      disabled={!writable}
                      title="Flip in draft"
                      onCheckedChange={(checked) => setDefault(parameter, checked)}
                    />
                  ) : (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={!writable}
                      className="max-w-47.5 font-mono"
                      onClick={() => setEditing(parameter)}
                    >
                      <span className="truncate">{shortValue(parameter.defaultValue, 26)}</span>
                      <PencilSimpleIcon />
                    </Button>
                  )}
                  <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
                    {state.label}
                  </span>
                </div>
                <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </div>
            );
          })}
        </div>
      )}

      <Alert variant="muted">
        <WarningIcon />
        <AlertDescription className="text-xs leading-relaxed">
          Resolved values are readable by every end user of your app. Public API keys are fine here;
          server credentials never are.
        </AlertDescription>
      </Alert>

      <NewParameterDialog envId={envId} open={creating} onOpenChange={setCreating} />

      {editing !== null && (
        <ValueDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={`Default value · ${editing.key}`}
          subtitle={`${editing.type} · edits the draft only${
            latestVersion === 0 ? "." : `. Apps keep getting v${latestVersion} until you publish.`
          }`}
          type={editing.type}
          value={editing.defaultValue}
          pending={update.isPending}
          onSave={(value) => {
            setDefault(editing, value);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
