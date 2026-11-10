import * as React from "react"

import { cn } from "@/lib/utils"

// story 4831 (바탕 한 벌 규격 v1 §5) — 날것 <select>의 자리. 브라우저 기본 <select> 위의 얇은 껍데기라 접근성(키보드 · 스크린리더 · 모바일 선택기)은 그대로이고,
// Input과 같은 테두리 · 높이 · 초점 링 · 글자 규칙(모바일 16px · lg 14px, story #4410)만 입힌다. 목록 상자를 직접 그리는 판은 후속.
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base transition-colors outline-none focus-visible:border-proof-citron focus-visible:ring-3 focus-visible:ring-proof-citron disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 lg:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export { Select }
