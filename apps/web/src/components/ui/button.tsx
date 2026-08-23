"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Slot } from "@radix-ui/react-slot"
const buttonVariants = cva(
  // story #2969 §2 PR-1(doc proofline-system-layer-2969) — focus 링을 시트론으로(버튼 시그니처,
  // 이 컴포넌트 한정 — 전역 --ring/proof-blue는 무변경). radius는 PR-T(#2969 PR-T)의
  // --radius 토큰 하향(0.625rem→0.25rem)을 그대로 상속(rounded-md=calc 파생, 이 파일 무편집).
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-proof-citron focus-visible:ring-3 focus-visible:ring-proof-citron active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        // story #2419 — rest 상태 bg-destructive/10 위 text-destructive는 3.97(AA 4.5 미달).
        // story #2420 v3 — text-foreground로 교체(15.58~16.72, 정의 시점 검증은
        // scripts/verify-tint-foreground-contrast.ts). --foreground 자체가 테마마다 값을
        // 가져 dark: 짝이 필요 없다. ⚠️hover 알파(light /20·dark /30)는 #2420 1단계 범위
        // 밖 — 사용처 스윕(AC7)에서 별도 처리한다.
        destructive:
          "bg-destructive/10 text-foreground hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive",
        link: "text-primary underline-offset-4 hover:underline",
        // story #2969 §2 PR-1 — shadow-sm 제거(§1.2: 인라인 표면은 그림자 대신 라인/색).
        // 이 자리는 "색"으로 대응 — hover:bg-primary/90(기존)이 이미 그 축을 맡고 있어
        // 별도 hairline 없이 이 변경만으로 §1.2 원칙을 만족한다(신규 색 발명 없음).
        hero: "bg-primary text-primary-foreground hover:bg-primary/90",
        glass: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default:
          "h-9 min-h-11 min-w-11 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-h-11 min-w-11 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-11",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  if (asChild) {
    return (
      <Slot
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    )
  }

  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
