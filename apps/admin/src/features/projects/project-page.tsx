import { ArrowLeftIcon, ArrowRightIcon, InfoIcon, PlusIcon } from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { ClientKeyRow } from "@/components/client-key-row";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { plural, relativeDay } from "@/lib/format";
import { errorMessage, useCreateEnvironment, useOverview } from "@/lib/queries";

export function ProjectPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const overview = useOverview();
  const [creating, setCreating] = useState(false);
  const project = overview.data?.find((candidate) => candidate.id === projectId);

  if (project === undefined) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {overview.isPending ? "Loading…" : "This project no longer exists."}
      </p>
    );
  }

  return (
    <div className="animate-lever-in flex flex-col gap-4.5">
      <Button variant="link" size="sm" asChild className="self-start px-0 text-muted-foreground">
        <Link to="/">
          <ArrowLeftIcon />
          Projects
        </Link>
      </Button>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-50 flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <span className="font-mono text-[12.5px] text-muted-foreground">{project.key}</span>
        </div>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon />
          New environment
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {project.environments.map((environment) => (
          <div key={environment.id} className="flex flex-col gap-3.5 rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-start gap-2.5">
              <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[15px] font-medium">{environment.key}</span>
                  {environment.latestVersion === 0 ? (
                    <Badge variant="warn" className="rounded-sm text-[11px]">
                      version 0 · nothing published
                    </Badge>
                  ) : (
                    <Badge variant="muted" className="rounded-sm font-mono text-[11px]">
                      v{environment.latestVersion}
                    </Badge>
                  )}
                  {environment.draftDirty && (
                    <Badge variant="warn" className="rounded-sm text-[11px]">
                      unpublished changes
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {plural(environment.parameterCount, "parameter")} ·{" "}
                  {plural(environment.conditionCount, "condition")} · created{" "}
                  {relativeDay(environment.createdAt)}
                </span>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link to="/environments/$envId/parameters" params={{ envId: environment.id }}>
                  Open
                  <ArrowRightIcon />
                </Link>
              </Button>
            </div>
            <ClientKeyRow clientKey={environment.clientKey} />
          </div>
        ))}
      </div>

      <Alert variant="muted">
        <InfoIcon />
        <AlertDescription className="text-[12.5px] leading-relaxed">
          Client keys are identifiers, not credentials. They authorize reading one environment's
          resolved values — which your end users can see anyway. Deleting a project or environment
          destroys its entire version history.
        </AlertDescription>
      </Alert>

      <EnvironmentDialog projectId={project.id} open={creating} onOpenChange={setCreating} />
    </div>
  );
}

const SLUG = /^[a-z0-9-]{1,64}$/;

function EnvironmentDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const create = useCreateEnvironment(projectId);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!SLUG.test(key)) {
      setError("key must be lowercase letters, numbers and dashes");
      return;
    }
    create.mutate(key, {
      onSuccess: () => {
        setKey("");
        setError("");
        onOpenChange(false);
      },
      onError: (thrown) => setError(errorMessage(thrown)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New environment</DialogTitle>
            <DialogDescription>
              It gets its own client key, parameters, conditions and version history.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="env-key">Key</Label>
            <Input
              id="env-key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="dev"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <span className="text-[11px] text-muted-foreground">
              prod, staging, dev — lowercase, dashes allowed
            </span>
          </div>
          {error !== "" && <p className="text-xs leading-relaxed text-del">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Create environment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
