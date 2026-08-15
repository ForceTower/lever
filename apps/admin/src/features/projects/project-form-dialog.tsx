import { useEffect, useState } from "react";
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
import type { Project } from "@/lib/api/types";
import { errorMessage, useCreateProject } from "@/lib/queries";

const SLUG = /^[a-z0-9-]{1,64}$/;

/**
 * Create and rename in one dialog, because they differ by exactly one field:
 * the key is picked once and never changes — it is what shows up in URLs and
 * logs, and renaming it would silently rewrite an operator's bookmarks.
 */
export function ProjectFormDialog({
  open,
  onOpenChange,
  project,
  onCreated,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project | null;
  onCreated?: (projectId: string) => void;
  onRename?: (name: string) => void;
}) {
  const renaming = project != null;
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const create = useCreateProject((projectId) => onCreated?.(projectId));

  useEffect(() => {
    if (!open) return;
    setKey("");
    setName(project?.name ?? "");
    setError("");
  }, [open, project]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") {
      setError("name is required");
      return;
    }
    if (renaming) {
      onRename?.(name.trim());
      return;
    }
    if (!SLUG.test(key)) {
      setError("key must be lowercase letters, numbers and dashes");
      return;
    }
    create.mutate(
      { key, name: name.trim() },
      { onError: (thrown) => setError(errorMessage(thrown)) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{renaming ? "Rename project" : "New project"}</DialogTitle>
            <DialogDescription>
              {renaming
                ? "The key never changes — only the display name."
                : "A project is a namespace. The key is what you will see in URLs and logs."}
            </DialogDescription>
          </DialogHeader>

          {!renaming && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project-key">Key</Label>
              <Input
                id="project-key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="melon"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
              <span className="text-[11px] text-muted-foreground">
                lowercase letters, numbers and dashes
              </span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Melon"
            />
          </div>

          {error !== "" && <p className="text-xs leading-relaxed text-del">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {renaming ? "Save" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
