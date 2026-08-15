import { ArrowsClockwiseIcon, TrashIcon } from "@phosphor-icons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { ClientKeyRow } from "@/components/client-key-row";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-context";
import { plural } from "@/lib/format";
import { useDeleteEnvironment, useEnvironmentSummary, useRotateClientKey } from "@/lib/queries";

export function SettingsPage() {
  const { envId } = useParams({ from: "/environments/$envId/settings" });
  const navigate = useNavigate();
  const { project, environment } = useEnvironmentSummary(envId);
  const { can } = useAuth();
  const rotate = useRotateClientKey(envId);
  const remove = useDeleteEnvironment(envId, () => void navigate({ to: "/" }));
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (environment === undefined || project === undefined) {
    return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  }

  const admin = can("config:admin");

  return (
    <div className="animate-lever-in flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Environment settings</h1>
        <p className="text-[13px] text-muted-foreground">
          {project.key} / {environment.key} ·{" "}
          {environment.latestVersion === 0
            ? "version 0, nothing published"
            : `live on v${environment.latestVersion}`}
        </p>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">Client key</h2>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Public by design. It only authorizes reading this environment's resolved values, which
            your end users can see anyway. Ship it in your app.
          </p>
        </div>
        <ClientKeyRow clientKey={environment.clientKey} />
        {admin && (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setRotating(true)}
          >
            <ArrowsClockwiseIcon />
            Rotate client key
          </Button>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-del-border bg-card p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-del">Delete environment</h2>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Deletes every parameter, condition and version in {project.key} / {environment.key}. The
            version chain is the audit log, and it goes with it. This cannot be undone.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!admin}
          className="self-start border-del-border text-del"
          onClick={() => setDeleting(true)}
        >
          <TrashIcon />
          Delete {environment.key}
        </Button>
      </section>

      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        title="Rotate the client key?"
        body="The old key stops working the moment you rotate, and every live stream on it is dropped. Apps still holding it fall back to their cached values, then to code defaults. Ship the new key before rotating."
        confirmLabel="Rotate key"
        pending={rotate.isPending}
        onConfirm={() => {
          rotate.mutate(undefined);
          setRotating(false);
        }}
      />

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete environment ${environment.key}`}
        body={`This deletes every parameter, condition and all ${plural(
          environment.latestVersion,
          "version",
        )} in ${environment.key}, including the audit log. Clients holding ${environment.clientKey} stop resolving immediately. This cannot be undone.`}
        expect={environment.key}
        confirmLabel="Delete environment"
        pending={remove.isPending}
        onConfirm={() => {
          remove.mutate(environment.key);
          setDeleting(false);
        }}
      />
    </div>
  );
}
