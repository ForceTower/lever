import { CubeIcon, InfoIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProjectOverview } from "@/lib/api/types";
import { plural, relativeDay } from "@/lib/format";
import { useDeleteProject, useOverview, useRenameProject } from "@/lib/queries";
import { ProjectFormDialog } from "@/features/projects/project-form-dialog";

export function ProjectsPage() {
  const overview = useOverview();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<ProjectOverview | null>(null);
  const [deleting, setDeleting] = useState<ProjectOverview | null>(null);
  const rename = useRenameProject();
  const remove = useDeleteProject();

  const projects = overview.data ?? [];

  return (
    <div className="animate-lever-in flex flex-col gap-4.5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-50 flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-[13px] text-muted-foreground">
            One deployment serves every project. {plural(projects.length, "project")}.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon />
          New project
        </Button>
      </div>

      {overview.isPending && (
        <div className="overflow-hidden rounded-lg border bg-card">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3.5 border-b p-4 last:border-b-0">
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-2.5 w-3/5" />
              </div>
              <Skeleton className="h-5.5 w-16" />
            </div>
          ))}
        </div>
      )}

      {!overview.isPending && projects.length === 0 && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed bg-card px-6 py-8">
          <CubeIcon className="size-6 text-muted-foreground" />
          <h2 className="text-[15px] font-semibold">No projects yet</h2>
          <p className="max-w-[52ch] text-[13px] leading-relaxed text-muted-foreground">
            This deployment is fresh out of <span className="font-mono text-xs">docker run</span>. A
            project is a namespace — create one, then add the environments your apps read from.
          </p>
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            Create the first project
          </Button>
        </div>
      )}

      {projects.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          {projects.map((project) => (
            <div
              key={project.id}
              className="flex items-center gap-3 border-b p-4 last:border-b-0 hover:bg-muted/50"
            >
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                className="flex min-w-0 flex-1 flex-col items-start gap-1.5"
              >
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <span className="font-mono text-sm font-medium">{project.key}</span>
                  <span className="text-[13px] text-muted-foreground">{project.name}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {project.environments.map((environment) => (
                    <Badge
                      key={environment.id}
                      variant="muted"
                      className="rounded-sm font-mono text-[11px]"
                    >
                      {environment.key} · v{environment.latestVersion}
                      {environment.draftDirty && <span className="size-1.5 rounded-full bg-warn" />}
                    </Badge>
                  ))}
                  <span className="text-[11px] text-muted-foreground">
                    created {relativeDay(project.createdAt)}
                  </span>
                </div>
              </Link>
              <Button
                variant="outline"
                size="icon-sm"
                title="Rename"
                className="text-muted-foreground"
                onClick={() => setRenaming(project)}
              >
                <PencilSimpleIcon />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                title="Delete"
                className="text-muted-foreground hover:text-del"
                onClick={() => setDeleting(project)}
              >
                <TrashIcon />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Alert variant="muted">
        <InfoIcon />
        <AlertDescription className="text-xs leading-relaxed">
          Deleting a project destroys every environment under it and their whole version history —
          the audit log goes with it.
        </AlertDescription>
      </Alert>

      <ProjectFormDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(projectId) => {
          setCreating(false);
          void navigate({ to: "/projects/$projectId", params: { projectId } });
        }}
      />

      <ProjectFormDialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        project={renaming}
        onRename={(name) => {
          if (renaming === null) return;
          rename.mutate({ id: renaming.id, name });
          setRenaming(null);
        }}
      />

      {deleting !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          title={`Delete project ${deleting.key}`}
          body={deleteBody(deleting)}
          expect={deleting.key}
          confirmLabel="Delete project"
          pending={remove.isPending}
          onConfirm={() => {
            remove.mutate({ id: deleting.id, confirm: deleting.key });
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

function deleteBody(project: ProjectOverview): string {
  const versions = project.environments.reduce(
    (total, environment) => total + environment.latestVersion,
    0,
  );
  return (
    `This deletes ${plural(project.environments.length, "environment")} and all ` +
    `${plural(versions, "published version")} under them. The version chain is this project's ` +
    "audit log — it is destroyed, not archived. Clients using these client keys stop resolving " +
    "immediately. This cannot be undone."
  );
}
