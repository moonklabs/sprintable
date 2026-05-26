import { cn } from "@/lib/utils";

interface SkeletonProps extends React.ComponentProps<"div"> {
  variant?: "rect" | "text" | "circle";
}

function Skeleton({ className, variant = "rect", ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "bg-gradient-to-r from-[var(--skeleton-base)] via-[var(--skeleton-highlight)] to-[var(--skeleton-base)]",
        "bg-[length:200%_100%]",
        "animate-skeleton-shimmer",
        "motion-reduce:animate-none motion-reduce:bg-none motion-reduce:bg-muted",
        variant === "rect" && "rounded-md",
        variant === "text" && "rounded h-4",
        variant === "circle" && "rounded-full aspect-square",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
