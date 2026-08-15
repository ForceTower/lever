import { CopyIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Public by design (research §7) — shown in full, never masked. */
export function ClientKeyRow({ clientKey }: { clientKey: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(clientKey);
      toast.success("Client key copied");
    } catch {
      toast.error("Could not reach the clipboard — copy it by hand.");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-md border bg-muted px-3 py-2.5">
      <span className="text-[11px] tracking-wider text-muted-foreground uppercase">client key</span>
      <span className="min-w-30 flex-1 font-mono text-[12.5px] break-all">{clientKey}</span>
      <Button variant="outline" size="xs" onClick={() => void copy()}>
        <CopyIcon />
        Copy
      </Button>
    </div>
  );
}
