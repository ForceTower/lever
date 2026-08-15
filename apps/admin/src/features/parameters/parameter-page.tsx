import {
  ArrowDownIcon,
  ArrowElbowDownRightIcon,
  ArrowLeftIcon,
  ArrowsLeftRightIcon,
  ArrowUpIcon,
  DotsSixVerticalIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConditionDialog } from "@/features/conditions/condition-dialog";
import { ValueDialog } from "@/features/parameters/value-dialog";
import type { Condition, JsonValue, ParameterType } from "@/lib/api/types";
import { PARAMETER_TYPES, isParameterType } from "@/lib/api/types";
import {
  clauseText,
  defaultValueFor,
  relativeDay,
  valueMatchesType,
  valueText,
} from "@/lib/format";
import {
  useConditions,
  useDeleteParameter,
  useEnvironmentSummary,
  useParameters,
  usePublishPreview,
  useReplaceConditionalValues,
  useUpdateParameter,
} from "@/lib/queries";

/** Which conditional value the value editor is open on, if any. */
type Editing = { kind: "default" } | { kind: "conditional"; index: number };

export function ParameterPage() {
  const { envId, parameterId } = useParams({
    from: "/environments/$envId/parameters/$parameterId",
  });
  const navigate = useNavigate();
  const parameters = useParameters(envId);
  const conditions = useConditions(envId);
  const preview = usePublishPreview(envId);
  const { environment } = useEnvironmentSummary(envId);
  const update = useUpdateParameter(envId);
  const replace = useReplaceConditionalValues(envId);
  const remove = useDeleteParameter(envId, () => {
    void navigate({ to: "/environments/$envId/parameters", params: { envId } });
  });

  const [editing, setEditing] = useState<Editing | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [typeChange, setTypeChange] = useState<ParameterType | null>(null);
  const [editingCondition, setEditingCondition] = useState<Condition | null | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const parameter = parameters.data?.find((candidate) => candidate.id === parameterId);
  if (parameter === undefined) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {parameters.isPending ? "Loading…" : "This parameter is no longer in the draft."}
      </p>
    );
  }

  const conditionsById = new Map((conditions.data ?? []).map((entry) => [entry.id, entry]));
  const latestVersion = environment?.latestVersion ?? 0;
  const diff = preview.data?.diff;
  const draftOnly =
    latestVersion === 0 ||
    (diff !== undefined &&
      [...diff.added, ...diff.changed].some((entry) => entry.key === parameter.key));
  const valueSubtitle = `${parameter.type} · edits the draft only${
    latestVersion === 0 ? "." : `. Apps keep getting v${latestVersion} until you publish.`
  }`;

  const writeValues = (values: { conditionId: string; value: JsonValue }[]): void => {
    replace.mutate({ id: parameter.id, values });
  };
  const currentValues = parameter.conditionalValues.map((entry) => ({
    conditionId: entry.conditionId,
    value: entry.value,
  }));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= currentValues.length) return;
    const next = [...currentValues];
    const [row] = next.splice(from, 1);
    if (row === undefined) return;
    next.splice(to, 0, row);
    writeValues(next);
  };

  const setConditionalValue = (index: number, value: JsonValue) => {
    writeValues(currentValues.map((entry, at) => (at === index ? { ...entry, value } : entry)));
  };

  // A type change revalidates every value the parameter holds; the ones that
  // would fail are named before the request, not after the 400.
  const mismatched =
    typeChange === null
      ? []
      : [
          ...(valueMatchesType(typeChange, parameter.defaultValue)
            ? []
            : [`defaultValue ${valueText(parameter.defaultValue)}`]),
          ...parameter.conditionalValues
            .filter((entry) => !valueMatchesType(typeChange, entry.value))
            .map(
              (entry) =>
                `value for ${conditionsById.get(entry.conditionId)?.name ?? "?"} ${valueText(entry.value)}`,
            ),
        ];

  const unusedConditions = (conditions.data ?? []).filter(
    (candidate) => !parameter.conditionalValues.some((cv) => cv.conditionId === candidate.id),
  );

  return (
    <div className="animate-lever-in flex flex-col gap-4">
      <Button variant="link" size="sm" asChild className="self-start px-0 text-muted-foreground">
        <Link to="/environments/$envId/parameters" params={{ envId }}>
          <ArrowLeftIcon />
          Parameters
        </Link>
      </Button>

      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-50 flex-1 flex-col gap-1.5">
          <h1 className="font-mono text-2xl font-medium tracking-tight break-all">
            {parameter.key}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              updated {relativeDay(parameter.updatedAt)}
            </span>
            {draftOnly && (
              <Badge variant="warn" className="rounded-full text-[10.5px] font-semibold">
                draft only
              </Badge>
            )}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-muted-foreground hover:text-del"
          onClick={() => setDeleting(true)}
        >
          <TrashIcon />
          Delete
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="parameter-type">Type</Label>
          <Select
            value={parameter.type}
            onValueChange={(next) => isParameterType(next) && setTypeChange(next)}
          >
            <SelectTrigger id="parameter-type" className="font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PARAMETER_TYPES.map((candidate) => (
                <SelectItem key={candidate} value={candidate} className="font-mono">
                  {candidate}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[11px] leading-snug text-muted-foreground">
            Changing type revalidates the default and every conditional value.
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="parameter-description">Description</Label>
          <Input
            id="parameter-description"
            value={description ?? parameter.description ?? ""}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={() => {
              if (description === null || description === (parameter.description ?? "")) return;
              update.mutate({ id: parameter.id, patch: { description } });
              setDescription(null);
            }}
            placeholder="What this gates, for you"
          />
          <span className="text-[11px] leading-snug text-muted-foreground">
            Operator-only. Never sent to apps.
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="text-[15px] font-semibold">Evaluation order</h2>
          <span className="text-xs text-muted-foreground">First match wins, top to bottom.</span>
        </div>

        {parameter.conditionalValues.length === 0 && (
          <p className="rounded-md border border-dashed p-4 text-[12.5px] leading-relaxed text-muted-foreground">
            No conditional values. Every client gets the default below — the common case.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {parameter.conditionalValues.map((entry, index) => {
            const condition = conditionsById.get(entry.conditionId);
            return (
              <div
                key={entry.id}
                draggable
                onDragStart={() => setDragFrom(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragFrom !== null && dragFrom !== index) move(dragFrom, index);
                  setDragFrom(null);
                }}
                onDragEnd={() => setDragFrom(null)}
                className="flex items-stretch overflow-hidden rounded-md border bg-card"
              >
                <div className="flex w-9.5 shrink-0 cursor-grab flex-col items-center justify-center gap-1 border-r bg-muted text-muted-foreground">
                  <span className="font-mono text-xs font-medium">{index + 1}</span>
                  <DotsSixVerticalIcon className="size-3.5" />
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-2.5 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold">
                      {condition?.name ?? "(missing condition)"}
                    </span>
                    {condition !== undefined && (
                      <Button
                        variant="link"
                        size="xs"
                        className="px-0 text-[11.5px]"
                        onClick={() => setEditingCondition(condition)}
                      >
                        edit rule
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    {(condition?.clauses ?? []).map((clause, at) => (
                      <span key={at} className="font-mono text-[11.5px] text-muted-foreground">
                        {clauseText(clause)}
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[11px] tracking-wider text-muted-foreground uppercase">
                      serve
                    </span>
                    {parameter.type === "boolean" ? (
                      <Button
                        variant="outline"
                        size="xs"
                        className="font-mono"
                        onClick={() => setConditionalValue(index, entry.value !== true)}
                      >
                        {valueText(entry.value)}
                        <ArrowsLeftRightIcon />
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="xs"
                        className="min-w-0 flex-1 justify-start font-mono"
                        onClick={() => setEditing({ kind: "conditional", index })}
                      >
                        <span className="flex-1 truncate text-left">{valueText(entry.value)}</span>
                        <PencilSimpleIcon />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 flex-col border-l">
                  <button
                    type="button"
                    title="Move up"
                    className="flex flex-1 items-center justify-center border-b px-2.5 text-muted-foreground hover:bg-muted"
                    onClick={() => move(index, index - 1)}
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    className="flex flex-1 items-center justify-center border-b px-2.5 text-muted-foreground hover:bg-muted"
                    onClick={() => move(index, index + 1)}
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Remove"
                    className="flex flex-1 items-center justify-center px-2.5 text-muted-foreground hover:bg-muted hover:text-del"
                    onClick={() => writeValues(currentValues.filter((_, at) => at !== index))}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              </div>
            );
          })}

          <div className="flex items-stretch overflow-hidden rounded-md border bg-muted">
            <div className="flex w-9.5 shrink-0 items-center justify-center border-r text-muted-foreground">
              <ArrowElbowDownRightIcon className="size-4" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold">Default</span>
                <span className="text-[11.5px] text-muted-foreground">
                  what resolves when nothing above matches
                </span>
              </div>
              {parameter.type === "boolean" ? (
                <Button
                  variant="outline"
                  size="xs"
                  className="self-start bg-card font-mono"
                  onClick={() =>
                    update.mutate({
                      id: parameter.id,
                      patch: { defaultValue: parameter.defaultValue !== true },
                    })
                  }
                >
                  {valueText(parameter.defaultValue)}
                  <ArrowsLeftRightIcon />
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="xs"
                  className="justify-start bg-card font-mono"
                  onClick={() => setEditing({ kind: "default" })}
                >
                  <span className="flex-1 truncate text-left">
                    {valueText(parameter.defaultValue)}
                  </span>
                  <PencilSimpleIcon />
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
          <Select
            value=""
            onValueChange={(conditionId) =>
              writeValues([
                ...currentValues,
                { conditionId, value: defaultValueFor(parameter.type) },
              ])
            }
            disabled={unusedConditions.length === 0}
          >
            <SelectTrigger className="min-w-42 flex-1">
              <SelectValue placeholder="Add a conditional value…" />
            </SelectTrigger>
            <SelectContent>
              {unusedConditions.map((condition) => (
                <SelectItem key={condition.id} value={condition.id}>
                  {condition.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            className="border-dashed"
            onClick={() => setEditingCondition(null)}
          >
            <PlusIcon />
            New condition
          </Button>
        </div>
      </div>

      <Alert variant="warn">
        <WarningIcon />
        <AlertDescription className="text-xs leading-relaxed">
          No secrets in config values. Everything here is readable by every end user of your app.
          Edits stay in the draft until you publish.
        </AlertDescription>
      </Alert>

      {editing !== null && (
        <ValueDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={`${editing.kind === "default" ? "Default value" : "Conditional value"} · ${parameter.key}`}
          subtitle={valueSubtitle}
          type={parameter.type}
          value={
            editing.kind === "default"
              ? parameter.defaultValue
              : (parameter.conditionalValues[editing.index]?.value ?? null)
          }
          pending={update.isPending || replace.isPending}
          onSave={(value) => {
            if (editing.kind === "default") {
              update.mutate({ id: parameter.id, patch: { defaultValue: value } });
            } else {
              setConditionalValue(editing.index, value);
            }
            setEditing(null);
          }}
        />
      )}

      {editingCondition !== undefined && (
        <ConditionDialog
          envId={envId}
          open
          onOpenChange={(open) => !open && setEditingCondition(undefined)}
          condition={editingCondition}
          onSaved={(saved) => {
            // A rule created from here is meant for this parameter — attach it
            // at the bottom of the order rather than making the operator go
            // find it in the picker.
            if (editingCondition === null) {
              writeValues([
                ...currentValues,
                { conditionId: saved.id, value: defaultValueFor(parameter.type) },
              ]);
            }
            setEditingCondition(undefined);
          }}
        />
      )}

      {typeChange !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setTypeChange(null)}
          title={`Change type to ${typeChange}?`}
          tone={mismatched.length > 0 ? "danger" : "info"}
          blocked={mismatched.length > 0}
          body={
            mismatched.length > 0
              ? `This is refused. Changing the type revalidates the default and every conditional value against ${typeChange}, and these do not match. Fix the values first, then change the type.`
              : `Changing the type revalidates the default and all ${parameter.conditionalValues.length} conditional value(s) against ${typeChange}. Every value here already matches, so the change goes through as one edit to your draft.`
          }
          {...(mismatched.length > 0 ? { list: { label: "would fail", items: mismatched } } : {})}
          confirmLabel="Change type"
          pending={update.isPending}
          onConfirm={() => {
            update.mutate({ id: parameter.id, patch: { type: typeChange } });
            setTypeChange(null);
          }}
        />
      )}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${parameter.key}?`}
        body={`Removing it from the draft means the next publish stops serving ${parameter.key} entirely, and apps fall back to their code defaults for it. Published versions keep it — nothing in history changes.`}
        confirmLabel="Delete parameter"
        pending={remove.isPending}
        onConfirm={() => {
          remove.mutate(parameter.id);
          setDeleting(false);
        }}
      />
    </div>
  );
}
