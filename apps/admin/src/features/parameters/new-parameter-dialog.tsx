import { WarningIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
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
import { PARAMETER_TYPES, isParameterType, type ParameterType } from "@/lib/api/types";
import { editorText, defaultValueFor, parseValue } from "@/lib/format";
import { errorMessage, useCreateParameter } from "@/lib/queries";

const PARAMETER_KEY = /^[a-zA-Z0-9_]{1,64}$/;

export function NewParameterDialog({
  envId,
  open,
  onOpenChange,
}: {
  envId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [type, setType] = useState<ParameterType>("boolean");
  const [defaultText, setDefaultText] = useState("false");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  const create = useCreateParameter(envId, (parameterId) => {
    onOpenChange(false);
    void navigate({
      to: "/environments/$envId/parameters/$parameterId",
      params: { envId, parameterId },
    });
  });

  useEffect(() => {
    if (!open) return;
    setKey("");
    setType("boolean");
    setDefaultText("false");
    setDescription("");
    setError("");
  }, [open]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!PARAMETER_KEY.test(key)) {
      setError("key must be [a-zA-Z0-9_], 1–64 chars");
      return;
    }
    const parsed = parseValue(type, defaultText);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    create.mutate(
      {
        key,
        type,
        defaultValue: parsed.value,
        ...(description.trim() === "" ? {} : { description: description.trim() }),
      },
      { onError: (thrown) => setError(errorMessage(thrown)) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New parameter</DialogTitle>
            <DialogDescription>
              It lands in the draft. Apps see it after you publish.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="parameter-key">Key</Label>
            <Input
              id="parameter-key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="enable_enrollment"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <span className="text-[11px] text-muted-foreground">[a-zA-Z0-9_], 1–64 chars</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="parameter-type">Type</Label>
            <Select
              value={type}
              onValueChange={(next) => {
                if (!isParameterType(next)) return;
                setType(next);
                setDefaultText(editorText(next, defaultValueFor(next)));
                setError("");
              }}
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
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="parameter-default">Default value</Label>
            <Input
              id="parameter-default"
              value={defaultText}
              onChange={(event) => setDefaultText(event.target.value)}
              placeholder={type === "json" ? '{"enabled":false}' : ""}
              spellCheck={false}
              className="font-mono"
            />
            <span className="text-[11px] text-muted-foreground">
              What resolves when no condition matches
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="parameter-description">Description</Label>
            <Input
              id="parameter-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Operator-only note"
            />
            <span className="text-[11px] text-muted-foreground">Never sent to apps</span>
          </div>

          {error !== "" && <p className="text-xs leading-relaxed text-del">{error}</p>}

          <Alert variant="warn">
            <WarningIcon />
            <AlertDescription className="text-[11.5px] leading-relaxed">
              No secrets. Resolved values are readable by every end user of your app — public keys
              are fine, server credentials are not.
            </AlertDescription>
          </Alert>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Create parameter
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
