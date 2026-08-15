import { InfoIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Clause, ClauseKind, Condition } from "@/lib/api/types";
import { clauseText, isStrictSemver } from "@/lib/format";
import { errorMessage, useSaveCondition } from "@/lib/queries";

type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn" | "exists";

/** A clause under construction: every operator's value shape at once, so
 * switching operators does not lose what was typed for the other shape. */
interface Draft {
  kind: ClauseKind;
  attribute: string;
  op: Op;
  value: string;
  items: string[];
  pendingItem: string;
}

const OPS: Record<ClauseKind, Op[]> = {
  platform: ["eq", "in"],
  appVersion: ["eq", "neq", "gt", "gte", "lt", "lte"],
  attribute: ["eq", "neq", "in", "notIn", "exists"],
};

const CLAUSE_KINDS: ClauseKind[] = ["platform", "appVersion", "attribute"];

function isClauseKind(value: string): value is ClauseKind {
  return (CLAUSE_KINDS as string[]).includes(value);
}

function isOp(value: string): value is Op {
  return Object.values(OPS).some((ops) => (ops as string[]).includes(value));
}

const PLACEHOLDERS: Record<ClauseKind, string> = {
  platform: "android",
  appVersion: "5.2.0",
  attribute: "premium",
};

function emptyDraft(kind: ClauseKind): Draft {
  return { kind, attribute: "", op: OPS[kind][0] ?? "eq", value: "", items: [], pendingItem: "" };
}

function toDraft(clause: Clause): Draft {
  // `exists` carries no value at all, and the list operators carry an array —
  // the draft holds both shapes so switching operators keeps what was typed.
  const value = "value" in clause ? clause.value : "";
  return {
    kind: clause.kind,
    attribute: clause.kind === "attribute" ? clause.attribute : "",
    op: clause.op,
    value: Array.isArray(value) ? "" : value,
    items: Array.isArray(value) ? [...value] : [],
    pendingItem: "",
  };
}

/** The one refusal that cannot wait for the server: a clause it could not build. */
function issueOf(draft: Draft): string {
  if (draft.kind === "attribute" && draft.attribute.trim() === "")
    return "attribute name is required";
  if (draft.op === "exists") return "";
  if (draft.op === "in" || draft.op === "notIn") {
    return draft.items.length > 0 ? "" : "add at least one value";
  }
  if (draft.value === "") return "value is required";
  if (draft.kind === "appVersion" && !isStrictSemver(draft.value)) {
    return `"${draft.value}" is not strict semver — use 5.2.0`;
  }
  return "";
}

/**
 * The draft as the clause the API stores, or null while the operator and the
 * kind do not pair up — the same operator/value pairing the service validates
 * (§4), so an impossible clause is never assembled in the first place.
 */
function toClause(draft: Draft): Clause | null {
  const attribute = draft.attribute.trim();
  switch (draft.kind) {
    case "platform":
      if (draft.op === "in") return { kind: "platform", op: "in", value: draft.items };
      if (draft.op === "eq") return { kind: "platform", op: "eq", value: draft.value };
      return null;
    case "appVersion":
      switch (draft.op) {
        case "eq":
        case "neq":
        case "gt":
        case "gte":
        case "lt":
        case "lte":
          return { kind: "appVersion", op: draft.op, value: draft.value };
        default:
          return null;
      }
    case "attribute":
      switch (draft.op) {
        case "exists":
          return { kind: "attribute", attribute, op: "exists" };
        case "in":
        case "notIn":
          return { kind: "attribute", attribute, op: draft.op, value: draft.items };
        case "eq":
        case "neq":
          return { kind: "attribute", attribute, op: draft.op, value: draft.value };
        default:
          return null;
      }
  }
}

export function ConditionDialog({
  envId,
  open,
  onOpenChange,
  condition,
  onSaved,
}: {
  envId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing — every parameter referencing the rule is retargeted at once. */
  condition?: Condition | null;
  onSaved?: (condition: Condition) => void;
}) {
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState("");
  const save = useSaveCondition(envId);

  useEffect(() => {
    if (!open) return;
    setName(condition?.name ?? "");
    setDrafts(
      condition === null || condition === undefined
        ? [emptyDraft("platform")]
        : condition.clauses.map(toDraft),
    );
    setError("");
  }, [open, condition]);

  const patch = (index: number, changes: Partial<Draft>) => {
    setDrafts((current) =>
      current.map((draft, position) => (position === index ? { ...draft, ...changes } : draft)),
    );
    setError("");
  };

  const submit = () => {
    if (name.trim() === "") {
      setError("A condition needs a name — parameters reference it by name.");
      return;
    }
    if (drafts.length === 0) {
      setError("At least one clause is required. An empty rule must never become match-all.");
      return;
    }
    const clauses = drafts.map(toClause).filter((clause) => clause !== null);
    if (drafts.some((draft) => issueOf(draft) !== "") || clauses.length !== drafts.length) {
      setError("Fix the clause errors above.");
      return;
    }
    save.mutate(
      { id: condition?.id ?? null, name: name.trim(), clauses },
      {
        onSuccess: (saved) => {
          onOpenChange(false);
          onSaved?.(saved);
        },
        onError: (thrown) => setError(errorMessage(thrown)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-160">
        <DialogHeader>
          <DialogTitle>{condition ? "Edit condition" : "New condition"}</DialogTitle>
          <DialogDescription>
            {condition
              ? "Every parameter referencing this rule is retargeted at once."
              : "A named rule, reusable across parameters in this environment."}
          </DialogDescription>
        </DialogHeader>

        {/* The negative margin gives focus rings room: an overflow container
            clips whatever the ring paints outside the content box. */}
        <div className="-mx-1.5 flex max-h-[60vh] flex-col gap-3.5 overflow-y-auto px-1.5 py-0.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="condition-name">Name</Label>
            <Input
              id="condition-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
              placeholder="android-5.2+"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Clauses — all must match</Label>
            {drafts.length === 0 && (
              <p className="rounded-md border border-dashed p-3.5 text-[12.5px] text-muted-foreground">
                No clauses yet.
              </p>
            )}
            {drafts.map((draft, index) => {
              const issue = issueOf(draft);
              const preview = issue === "" ? toClause(draft) : null;
              const wantsList = draft.op === "in" || draft.op === "notIn";
              const wantsNothing = draft.op === "exists";
              return (
                <div key={index} className="flex flex-col gap-2 rounded-md border bg-muted p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Select
                      value={draft.kind}
                      onValueChange={(next) => {
                        if (!isClauseKind(next)) return;
                        patch(index, { ...emptyDraft(next), attribute: draft.attribute });
                      }}
                    >
                      <SelectTrigger size="sm" className="w-32 font-mono text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CLAUSE_KINDS.map((kind) => (
                          <SelectItem key={kind} value={kind} className="font-mono">
                            {kind}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {draft.kind === "attribute" && (
                      <Input
                        value={draft.attribute}
                        onChange={(event) => patch(index, { attribute: event.target.value })}
                        placeholder="tier"
                        className="h-8 w-28 font-mono text-xs"
                      />
                    )}

                    <Select
                      value={draft.op}
                      onValueChange={(op) => isOp(op) && patch(index, { op })}
                    >
                      <SelectTrigger size="sm" className="w-26 font-mono text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OPS[draft.kind].map((op) => (
                          <SelectItem key={op} value={op} className="font-mono">
                            {op}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="ml-auto text-muted-foreground"
                      title="Remove clause"
                      onClick={() =>
                        setDrafts((current) => current.filter((_, position) => position !== index))
                      }
                    >
                      <XIcon />
                    </Button>
                  </div>

                  {!wantsList && !wantsNothing && (
                    <Input
                      value={draft.value}
                      onChange={(event) => patch(index, { value: event.target.value })}
                      placeholder={PLACEHOLDERS[draft.kind]}
                      spellCheck={false}
                      className="h-8 font-mono text-xs"
                    />
                  )}

                  {wantsList && (
                    <div className="flex flex-col gap-2">
                      {draft.items.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {draft.items.map((item, itemIndex) => (
                            <span
                              key={`${item}-${itemIndex}`}
                              className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-1 font-mono text-[11.5px]"
                            >
                              {item}
                              <button
                                type="button"
                                className="text-muted-foreground"
                                onClick={() =>
                                  patch(index, {
                                    items: draft.items.filter((_, at) => at !== itemIndex),
                                  })
                                }
                              >
                                <XIcon className="size-2.5" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <Input
                        value={draft.pendingItem}
                        onChange={(event) => patch(index, { pendingItem: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          const item = draft.pendingItem.trim();
                          if (item === "") return;
                          patch(index, { items: [...draft.items, item], pendingItem: "" });
                        }}
                        placeholder="type a value, press Enter"
                        className="h-8 font-mono text-xs"
                      />
                    </div>
                  )}

                  {wantsNothing && (
                    <span className="text-[11.5px] text-muted-foreground">
                      No value — matches whenever the attribute is present.
                    </span>
                  )}

                  {issue !== "" && (
                    <span className="font-mono text-[11.5px] text-del">{issue}</span>
                  )}
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {preview === null ? "…" : clauseText(preview)}
                  </span>
                </div>
              );
            })}

            <Button
              variant="outline"
              size="sm"
              className="self-start border-dashed"
              onClick={() => setDrafts((current) => [...current, emptyDraft("attribute")])}
            >
              <PlusIcon />
              Add clause
            </Button>
          </div>

          {error !== "" && <p className="text-xs leading-relaxed text-del">{error}</p>}

          <Alert variant="muted">
            <InfoIcon />
            <AlertDescription className="text-[11.5px] leading-relaxed">
              Missing context never matches — not even negated operators. A client that sends no
              platform does not match anything about platform.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={submit}>
            {condition ? "Save condition" : "Create condition"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
