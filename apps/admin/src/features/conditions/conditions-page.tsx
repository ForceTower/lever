import { InfoIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/auth-context";
import { ConditionDialog } from "@/features/conditions/condition-dialog";
import type { Condition } from "@/lib/api/types";
import { clauseText, plural, relativeDay } from "@/lib/format";
import { useConditions, useDeleteCondition, useParameters } from "@/lib/queries";

export function ConditionsPage() {
  const { envId } = useParams({ from: "/environments/$envId/conditions" });
  const conditions = useConditions(envId);
  const parameters = useParameters(envId);
  const { can } = useAuth();
  const remove = useDeleteCondition(envId);
  const [editing, setEditing] = useState<Condition | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Condition | null>(null);

  const usersOf = (condition: Condition) =>
    (parameters.data ?? [])
      .filter((parameter) =>
        parameter.conditionalValues.some((value) => value.conditionId === condition.id),
      )
      .map((parameter) => parameter.key);

  const blockedBy = deleting === null ? [] : usersOf(deleting);
  const writable = can("config:write");

  return (
    <div className="animate-lever-in flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-45 flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Conditions</h1>
          <p className="text-[13px] text-muted-foreground">
            Named, reusable rules. One edit retargets every parameter that references it.
          </p>
        </div>
        {writable && (
          <Button onClick={() => setEditing(null)}>
            <PlusIcon />
            New condition
          </Button>
        )}
      </div>

      {conditions.isPending && (
        <div className="flex flex-col gap-2.5">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex flex-col gap-2 rounded-lg border bg-card p-4">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-2.5 w-64" />
            </div>
          ))}
        </div>
      )}

      {!conditions.isPending && (conditions.data ?? []).length === 0 && (
        <p className="rounded-lg border border-dashed bg-card px-6 py-7 text-[13px] leading-relaxed text-muted-foreground">
          No conditions yet. Every parameter serves its default to everyone until a rule says
          otherwise.
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        {(conditions.data ?? []).map((condition) => {
          const users = usersOf(condition);
          return (
            <div
              key={condition.id}
              className="flex flex-wrap gap-3 rounded-lg border bg-card p-3.5"
            >
              <div className="flex min-w-45 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-sm font-semibold">{condition.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {users.length === 0
                      ? "not referenced"
                      : `used by ${plural(users.length, "parameter")}`}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {condition.clauses.map((clause, index) => (
                    <span key={index} className="font-mono text-[11.5px] text-muted-foreground">
                      {clauseText(clause)}
                    </span>
                  ))}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  updated {relativeDay(condition.updatedAt)}
                </span>
              </div>
              {writable && (
                <div className="flex items-start gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => setEditing(condition)}>
                    <PencilSimpleIcon />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-del"
                    onClick={() => setDeleting(condition)}
                  >
                    <TrashIcon />
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Alert variant="muted">
        <InfoIcon />
        <AlertDescription className="text-xs leading-relaxed">
          Clauses are ANDed — a condition matches only when all of them match. There is no OR and no
          nesting. Missing context never matches:{" "}
          <span className="font-mono">attribute tier neq premium</span> does not match a client that
          sent no <span className="font-mono">tier</span>.
        </AlertDescription>
      </Alert>

      {editing !== undefined && (
        <ConditionDialog
          envId={envId}
          open
          onOpenChange={(open) => !open && setEditing(undefined)}
          condition={editing}
        />
      )}

      {deleting !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          title={
            blockedBy.length > 0 ? `Cannot delete ${deleting.name}` : `Delete ${deleting.name}?`
          }
          blocked={blockedBy.length > 0}
          body={
            blockedBy.length > 0
              ? `This condition is still referenced by ${plural(blockedBy.length, "parameter")}. Remove those conditional values first — deleting a referenced condition is refused.`
              : "No parameter references this condition, so deleting it changes no resolved value. It disappears from the library for this environment."
          }
          {...(blockedBy.length > 0 ? { list: { label: "referenced by", items: blockedBy } } : {})}
          confirmLabel="Delete condition"
          pending={remove.isPending}
          onConfirm={() => {
            remove.mutate(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}
