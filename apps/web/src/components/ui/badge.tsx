import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // story #2969 §1.4/§2 PR-1(doc proofline-system-layer-2969) — badge.tsx는 §1.4 "proof-cut-xs
  // 소 컷(태그·마커류)" 목록에 명시 등재. rounded-full→proof-cut+proof-cut-xs 컷태그로,
  // shadow-sm 제거(§1.2: 인라인 표면은 그림자 대신 라인 — border-transparent(default/success
  // 등)는 이미 그 자리 없이도 무회귀, 계열 variant는 기존 border-*/70 hairline이 그대로 그
  // 역할). ⚠️mono 라벨(라틴 전용) 스타일은 이 공유 primitive에 넣지 않는다 — 이 앱 배지
  // 소비처 대다수가 한글 텍스트라 전역 적용 시 [[feedback-ui-text-agent-tone]] 부류가 아니라
  // 2967 교훈(mono가 한글서 흐림)을 그대로 재현한다. 라틴 전용 콘텐츠(있다면)는 호출부가
  // 개별 className으로 옵트인.
  "group/badge proof-cut proof-cut-xs inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
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
        // story #2937(유나 P0-02 chip 전수 감사, 2026-08-22) — tint 배경 변형 중 chip만
        // text-muted-foreground(ink-3) 잔존해 위 success/info/warning/destructive와 같은
        // #2420 v3 규칙("tint 배경 위 글자는 text-foreground")을 못 지키고 있었다. 실측: ink-3
        // on bg-muted/70 = 3.55 라이트(AA 4.5 미달)·소비처 ~30(loops/retro/standup/gates/
        // trust/recruiter/agents/cage) 라이트 체계적 갭. text-foreground로 이행. 위계
        // de-emphasis는 색이 아니라 tint 배경+작은 크기+pill 형태가 담당(다른 tint 변형이
        // 이미 증명) — 무회귀.
        chip: "border-border/80 bg-muted/70 text-foreground",
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
