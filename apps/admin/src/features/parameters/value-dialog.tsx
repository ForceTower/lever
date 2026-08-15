import { ArrowsLeftRightIcon, WarningIcon } from "@phosphor-icons/react";
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
import { Textarea } from "@/components/ui/textarea";
import type { JsonValue, ParameterType } from "@/lib/api/types";
import { editorText, parseValue } from "@/lib/format";

/**
 * The one place a value is typed by hand. It refuses to save anything that is
 * not a value of the parameter's type — the same rule the server applies, run
 * as you type so the refusal arrives before the request does.
 */
export function ValueDialog({
  open,
  onOpenChange,
  title,
  subtitle,
  type,
  value,
  pending = false,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle: string;
  type: ParameterType;
  value: JsonValue;
  pending?: boolean;
  onSave: (value: JsonValue) => void;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (open) setText(editorText(type, value));
  }, [open, type, value]);

  const parsed = parseValue(type, text);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {type === "json" && (
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              spellCheck={false}
              rows={9}
              className="font-mono text-[12.5px] leading-relaxed"
            />
          )}
          {type === "string" && (
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              spellCheck={false}
              className="font-mono"
            />
          )}
          {type === "number" && (
            <Input
              type="number"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="font-mono"
            />
          )}
          {type === "boolean" && (
            <Button
              variant="outline"
              className="self-start font-mono"
              onClick={() => setText(text === "true" ? "false" : "true")}
            >
              {text}
              <ArrowsLeftRightIcon />
            </Button>
          )}

          {!parsed.ok && (
            <p className="font-mono text-xs leading-relaxed text-del">{parsed.message}</p>
          )}

          <Alert variant="warn">
            <WarningIcon />
            <AlertDescription className="text-[11.5px] leading-relaxed">
              No secrets. This value is readable by every end user of your app — public keys are
              fine, server credentials are not.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!parsed.ok || pending}
            onClick={() => {
              if (parsed.ok) onSave(parsed.value);
            }}
          >
            Save to draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
