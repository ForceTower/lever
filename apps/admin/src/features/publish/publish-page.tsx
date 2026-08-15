import { ArrowRightIcon, CheckCircleIcon, RocketLaunchIcon } from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/auth-context";
import { ApiError } from "@/lib/api";
import type { SnapshotDiff, SnapshotParameter } from "@/lib/api/types";
import { clauseText, valueText } from "@/lib/format";
import { toastError, useEnvironmentSummary, usePublish, usePublishPreview } from "@/lib/queries";
import { cn } from "@/lib/utils";

type Glyph = "+" | "−" | "~" | " ";

interface ConditionalRow {
  glyph: Glyph;
  name: string;
  note: string;
  clauses: string[];
  before: string | null;
  after: string | null;
}

interface EntryRow {
  key: string;
  glyph: Glyph;
  typeText: string;
  summary: string;
  defaultBefore: string | null;
  defaultAfter: string | null;
  conditionals: ConditionalRow[];
}

/**
 * One parameter's before/after, read the way an operator asks about it: what
 * the default becomes, and — rule by rule — which conditional values appeared,
 * moved, changed value, or stopped applying.
 */
function toEntry(
  key: string,
  before: SnapshotParameter | null,
  after: SnapshotParameter | null,
  glyph: Glyph,
): EntryRow {
  const source = after ?? before;
  const names = [
    ...new Set([
      ...(before?.conditionalValues ?? []).map((entry) => entry.condition.name),
      ...(after?.conditionalValues ?? []).map((entry) => entry.condition.name),
    ]),
  ];

  const conditionals = names.map((name): ConditionalRow => {
    const beforeIndex = (before?.conditionalValues ?? []).findIndex(
      (entry) => entry.condition.name === name,
    );
    const afterIndex = (after?.conditionalValues ?? []).findIndex(
      (entry) => entry.condition.name === name,
    );
    const beforeEntry = before?.conditionalValues[beforeIndex];
    const afterEntry = after?.conditionalValues[afterIndex];
    const reference = afterEntry ?? beforeEntry;

    if (beforeEntry === undefined) {
      return {
        glyph: "+",
        name,
        note: `new rule at position ${afterIndex + 1}`,
        clauses: (reference?.condition.clauses ?? []).map(clauseText),
        before: null,
        after: afterEntry === undefined ? null : valueText(afterEntry.value),
      };
    }
    if (afterEntry === undefined) {
      return {
        glyph: "−",
        name,
        note: "no longer applies",
        clauses: (reference?.condition.clauses ?? []).map(clauseText),
        before: valueText(beforeEntry.value),
        after: null,
      };
    }

    const valueChanged = valueText(beforeEntry.value) !== valueText(afterEntry.value);
    const ruleChanged =
      JSON.stringify(beforeEntry.condition.clauses) !==
      JSON.stringify(afterEntry.condition.clauses);
    const moved = beforeIndex !== afterIndex;
    const notes = [
      valueChanged ? "value changed" : "",
      ruleChanged ? "rule edited" : "",
      moved ? `moved to position ${afterIndex + 1}` : "",
    ].filter((note) => note !== "");

    return {
      glyph: notes.length > 0 ? "~" : " ",
      name,
      note: notes.length > 0 ? notes.join(" · ") : `position ${afterIndex + 1} · unchanged`,
      clauses: afterEntry.condition.clauses.map(clauseText),
      before: valueChanged ? valueText(beforeEntry.value) : null,
      after: valueText(afterEntry.value),
    };
  });

  const typeChanged = before !== null && after !== null && before.type !== after.type;
  const defaultChanged =
    before === null ||
    after === null ||
    valueText(before.defaultValue) !== valueText(after.defaultValue);

  return {
    key,
    glyph,
    typeText:
      typeChanged && before !== null && after !== null
        ? `${before.type} → ${after.type}`
        : (source?.type ?? ""),
    summary:
      before === null
        ? "new parameter"
        : after === null
          ? "stops being served"
          : defaultChanged
            ? "default changed"
            : "conditional values changed",
    defaultBefore: before !== null && defaultChanged ? valueText(before.defaultValue) : null,
    defaultAfter: after === null ? null : valueText(after.defaultValue),
    conditionals,
  };
}

function groupsOf(diff: SnapshotDiff): { title: string; entries: EntryRow[] }[] {
  return [
    {
      title: "Added",
      entries: diff.added.map((entry) => toEntry(entry.key, null, entry.after, "+")),
    },
    {
      title: "Removed",
      entries: diff.removed.map((entry) => toEntry(entry.key, entry.before, null, "−")),
    },
    {
      title: "Changed",
      entries: diff.changed.map((entry) => toEntry(entry.key, entry.before, entry.after, "~")),
    },
  ].filter((group) => group.entries.length > 0);
}

export function PublishPage() {
  const { envId } = useParams({ from: "/environments/$envId/publish" });
  const preview = usePublishPreview(envId);
  const { project, environment } = useEnvironmentSummary(envId);
  const { can } = useAuth();
  const [published, setPublished] = useState<{ version: number; diff: SnapshotDiff } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const publish = usePublish(envId, (version) => {
    setPublished({ version, diff: preview.data?.diff ?? { added: [], removed: [], changed: [] } });
  });

  const latestVersion = environment?.latestVersion ?? 0;
  const next = latestVersion + 1;
  const path = project === undefined ? "" : `${project.key} / ${environment?.key ?? ""}`;
  const diff = preview.data?.diff;
  const count =
    diff === undefined ? 0 : diff.added.length + diff.removed.length + diff.changed.length;

  const backToParameters = (
    <Button variant="outline" size="sm" asChild>
      <Link to="/environments/$envId/parameters" params={{ envId }}>
        Back to parameters
        <ArrowRightIcon />
      </Link>
    </Button>
  );

  return (
    <div className="animate-lever-in flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Review draft</h1>
        <p className="text-[13px] text-muted-foreground">
          {published !== null
            ? path
            : latestVersion === 0
              ? `First publish for ${path} — v0 → v1`
              : `v${latestVersion} → v${next} for ${path}`}
        </p>
      </div>

      {preview.isPending && <Skeleton className="h-40 w-full rounded-lg" />}

      {published !== null && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-add-border bg-add-bg px-5 py-6">
          <CheckCircleIcon className="size-6 text-add" />
          <h2 className="text-[17px] font-semibold text-add">Now live as v{published.version}</h2>
          <p className="max-w-[54ch] text-[13px] leading-relaxed text-add/90">
            Clients pick it up within seconds — a stream nudge, then a normal fetch-and-activate.{" "}
            {published.diff.added.length} added, {published.diff.removed.length} removed,{" "}
            {published.diff.changed.length} changed. Your draft now matches v{published.version}.
          </p>
          {backToParameters}
        </div>
      )}

      {published === null && !preview.isPending && count === 0 && (
        <div className="flex flex-col items-start gap-3 rounded-lg border bg-card px-5 py-6">
          <CheckCircleIcon className="size-5.5 text-add" />
          <h2 className="text-[15px] font-semibold">Nothing to publish</h2>
          <p className="max-w-[52ch] text-[13px] leading-relaxed text-muted-foreground">
            {latestVersion === 0
              ? "This environment has no parameters and nothing published. There is no snapshot to freeze."
              : `Your draft is byte-identical to v${latestVersion}. Publishing would append an identical version, so it is refused. Edit something first.`}
          </p>
          {backToParameters}
        </div>
      )}

      {published === null && diff !== undefined && count > 0 && (
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-wrap gap-2">
            <Badge variant="add" className="h-6 rounded-full px-2.5">
              {diff.added.length} added
            </Badge>
            <Badge variant="del" className="h-6 rounded-full px-2.5">
              {diff.removed.length} removed
            </Badge>
            <Badge variant="warn" className="h-6 rounded-full px-2.5">
              {diff.changed.length} changed
            </Badge>
          </div>

          {groupsOf(diff).map((group) => (
            <div key={group.title} className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold">{group.title}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {group.entries.length}
                </span>
              </div>
              {group.entries.map((entry) => (
                <DiffEntry key={entry.key} entry={entry} />
              ))}
            </div>
          ))}

          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3.5">
            <p className="min-w-45 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
              Publishing freezes the draft as v{next}. It is append-only: you can roll back later,
              but never edit or delete a version.
            </p>
            <Button size="lg" disabled={!can("config:publish")} onClick={() => setConfirming(true)}>
              <RocketLaunchIcon />
              Publish v{next}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="info"
        title={`Publish v${next}?`}
        body={`This freezes your draft as v${next} and every client starts resolving it within seconds. Versions are append-only — v${next} can be rolled back later, never edited.`}
        confirmLabel={`Publish v${next}`}
        pending={publish.isPending}
        onConfirm={() => {
          setConfirming(false);
          publish.mutate(latestVersion, {
            onError: (error) => {
              if (error instanceof ApiError && error.code === "publish_conflict") {
                setConflict(error.message);
                return;
              }
              toastError(error);
            },
          });
        }}
      />

      {conflict !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConflict(null)}
          title="Publish refused — conflict"
          body={`${conflict} Publishing now would bury changes you have not seen. Reload to diff your draft against what is actually live.`}
          confirmLabel="Reload the diff"
          tone="danger"
          onConfirm={() => {
            setConflict(null);
            void preview.refetch();
          }}
        />
      )}
    </div>
  );
}

function DiffEntry({ entry }: { entry: EntryRow }) {
  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted px-3 py-2.5">
        <span className="font-mono text-[10px] text-muted-foreground">{entry.glyph}</span>
        <span className="font-mono text-[13px] font-medium">{entry.key}</span>
        <Badge
          variant="outline"
          className="rounded-sm font-mono text-[10px] tracking-wider uppercase"
        >
          {entry.typeText}
        </Badge>
        <span className="ml-auto text-[11.5px] text-muted-foreground">{entry.summary}</span>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] tracking-wider text-muted-foreground uppercase">
            default
          </span>
          <ValueChange before={entry.defaultBefore} after={entry.defaultAfter} emphasis />
        </div>

        {entry.conditionals.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-[11px] tracking-wider text-muted-foreground uppercase">
              conditional values
            </span>
            {entry.conditionals.map((conditional) => (
              <div key={conditional.name} className="flex gap-2.5 rounded-sm border px-2.5 py-2.5">
                <span className="w-3.5 shrink-0 font-mono text-[11px] text-muted-foreground">
                  {conditional.glyph}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-semibold">{conditional.name}</span>
                    <span className="text-[11px] text-muted-foreground">{conditional.note}</span>
                  </div>
                  {conditional.clauses.map((clause) => (
                    <span key={clause} className="font-mono text-[11px] text-muted-foreground">
                      {clause}
                    </span>
                  ))}
                  <ValueChange before={conditional.before} after={conditional.after} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ValueChange({
  before,
  after,
  emphasis = false,
}: {
  before: string | null;
  after: string | null;
  emphasis?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {before !== null && (
        <span className="font-mono text-xs text-muted-foreground line-through break-all">
          {before}
        </span>
      )}
      {before !== null && after !== null && (
        <ArrowRightIcon className="size-3 text-muted-foreground" />
      )}
      {after !== null && (
        <span className={cn("font-mono text-xs break-all", emphasis && "font-medium")}>
          {after}
        </span>
      )}
    </div>
  );
}
