import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// story #2976 — twMerge는 프로젝트의 실제 Tailwind 설정을 읽지 않고 표준 테마 값(굵기는
// thin~black, 크기는 xs~9xl 등) 이름만 기본 내장한다. 우리 `@theme inline`(globals.css)이
// 정의한 커스텀 테마 키(`--font-weight-editorial-*`·`--text-editorial-*`)는 그 목록에 없어,
// 같은 `font-`/`text-` 접두를 공유하는 다른 충돌군(예: font-family·text-color)의 더 관대한
// arbitrary-name 매처가 먼저 먹혀버린다 — `cn('font-heading', 'font-editorial-heading')`이나
// `cn('text-muted-foreground', 'text-editorial-ui')`에서 뒤 클래스가 앞을 조용히 지운다
// (실측: PR#3406 페이지헤더 인라인 style 우회 + 이 그라운딩에서 text-color 축도 동일 패턴
// 확인·2026-08-24). 처방 — `extendTailwindMerge`로 실제 커스텀 테마 값을 알려준다: 이러면
// twMerge가 이 이름들을 정확한 충돌군(font-weight·font-size)으로 분류해 서로 다른 축의
// 클래스(family+weight, color+size)는 공존하고, 같은 축끼리(weight+weight, size+size)는
// 여전히 올바르게 충돌(뒤가 이김)한다 — 실측 확認 완료.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      'font-weight': ['editorial-heading', 'editorial-claim'],
      'text': ['editorial-body', 'editorial-ui', 'editorial-meta', 'editorial-claim'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
