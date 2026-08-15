import { RocketLaunchIcon, WarningDiamondIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Says what actually happens — the design's rule is that a refusal explains itself. */
  body: string;
  tone?: "danger" | "info";
  confirmLabel?: string;
  /** When set, the operator must type this exact string (a project or environment key). */
  expect?: string;
  /** Names whatever is standing in the way, e.g. the parameters using a condition. */
  list?: { label: string; items: string[] };
  /** A refusal: explained, and with nothing to press but Close. */
  blocked?: boolean;
  pending?: boolean;
  onConfirm?: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  tone = "danger",
  confirmLabel = "Confirm",
  expect,
  list,
  blocked = false,
  pending = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const Icon = tone === "danger" ? WarningDiamondIcon : RocketLaunchIcon;
  const canConfirm = !blocked && !pending && (expect === undefined || typed === expect);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3">
          <Alert variant={tone === "danger" ? "destructive" : "muted"}>
            <Icon />
            <AlertDescription className="text-[12.5px] leading-relaxed">{body}</AlertDescription>
          </Alert>

          {list !== undefined && list.items.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-md border p-3">
              <span className="text-[11px] tracking-wider text-muted-foreground uppercase">
                {list.label}
              </span>
              {list.items.map((item) => (
                <span key={item} className="font-mono text-xs">
                  {item}
                </span>
              ))}
            </div>
          )}

          {expect !== undefined && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm-echo">Type {expect} to confirm</Label>
              <Input
                id="confirm-echo"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder={expect}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline">{blocked ? "Close" : "Cancel"}</Button>
          </AlertDialogCancel>
          {!blocked && (
            <Button
              variant={tone === "danger" ? "danger" : "default"}
              disabled={!canConfirm}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
