import { cn } from "@/lib/utils";

interface SkeletonProps extends React.ComponentProps<"div"> {
  variant?: "rect" | "text" | "circle";
  /** 문장 요소(<p> 등) 안에 둘 때 "span" — <p> 안의 <div>는 HTML 파서가 <p>를 쪼개 줄 상자가 달라진다(story #4219). */
  as?: "div" | "span";
}

function Skeleton({ className, variant = "rect", as: Tag = "div", ...props }: SkeletonProps) {
  return (
    <Tag
      data-slot="skeleton"
      className={cn(
        "bg-gradient-to-r from-[var(--skeleton-base)] via-[var(--skeleton-highlight)] to-[var(--skeleton-base)]",
        "bg-[length:200%_100%]",
        "animate-skeleton-shimmer",
        "motion-reduce:animate-none motion-reduce:bg-none motion-reduce:bg-muted",
        variant === "rect" && "rounded-md",
        variant === "text" && "rounded h-4",
        Tag === "span" && "inline-block",
        variant === "circle" && "rounded-full aspect-square",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
