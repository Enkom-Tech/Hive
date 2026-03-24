import { cn } from "../lib/utils";

interface HiveLogoIconProps {
  className?: string;
  "aria-hidden"?: boolean;
}

/**
 * Hive app logo (public/Hive.png — URL must match case for Linux deploys).
 * Use in the company rail, headers, or anywhere the product is identified.
 */
export function HiveLogoIcon({ className, "aria-hidden": ariaHidden = true }: HiveLogoIconProps) {
  return (
    <img
      src="/Hive.png"
      alt="Hive"
      className={cn("h-5 w-5 shrink-0 dark:invert", className)}
      aria-hidden={ariaHidden}
    />
  );
}
