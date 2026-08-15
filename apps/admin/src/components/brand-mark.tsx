import { ToggleRightIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-[22px] shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground",
        className,
      )}
    >
      <ToggleRightIcon className="size-[15px]" />
    </span>
  );
}

export function BrandLockup({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <span className="text-[15px] font-semibold tracking-tight">Lever</span>
    </div>
  );
}
