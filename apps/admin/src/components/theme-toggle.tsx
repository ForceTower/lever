import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Light/dark only — the design's chrome has one switch, not a three-way picker. */
export function ThemeToggle({
  className,
  withLabel = false,
}: {
  className?: string;
  withLabel?: boolean;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const next = resolvedTheme === "dark" ? "light" : "dark";

  return (
    <Button
      variant="outline"
      size={withLabel ? "sm" : "icon-sm"}
      onClick={() => setTheme(next)}
      className={cn("text-muted-foreground", className)}
      title="Theme"
    >
      <SunIcon className="hidden dark:block" />
      <MoonIcon className="dark:hidden" />
      {withLabel && <span className="capitalize">{next}</span>}
    </Button>
  );
}
