import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all shadow-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "border-border/70 bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        // story #2419 — bg-destructive/10 위 text-destructive는 3.97(AA 4.5 미달, verify-rail.tsx
        // 실패 박스와 동일 조합). story #2420 v3 규칙(계열별 토큰 대신 규칙 하나) — tint 배경
        // 위 글자는 text-foreground(16.72, scripts/verify-tint-foreground-contrast.ts가 정의
        // 시점에 검증). --foreground 자체가 테마마다 값을 가지므로 dark: 짝이 따로 필요 없다.
        destructive:
          "bg-destructive/10 text-foreground focus-visible:ring-destructive dark:bg-destructive/20 dark:focus-visible:ring-destructive [a]:hover:bg-destructive/20",
        outline:
          "border-border/80 bg-background text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        // story #2420 v3 규칙(계열별 토큰 대신 규칙 하나) — destructive와 동일: tint 배경 위
        // 글자는 text-foreground다(계열색 아님). 계열은 border/bg로 전한다. 유나 라이브 실측
        // (2026-08-10, dev): text-warning on bg-warning-tint = 2.06(라이트, AA 4.5 미달) →
        // text-foreground로 이행 시 18.44(라이트·success 17.47·info 17.38·전 계열 AA,
        // scripts/verify-tint-foreground-contrast.ts가 정의 시점에 검증). --foreground가
        // 테마마다 값을 가지므로 dark: 짝이 따로 필요 없다.
        success: "border-success-border bg-success-tint text-foreground",
        info: "border-info-border bg-info-tint text-foreground",
        warning: "border-warning-border bg-warning-tint text-foreground",
        chip: "border-border/80 bg-muted/70 text-muted-foreground",
        counter: "border-transparent bg-destructive text-destructive-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
