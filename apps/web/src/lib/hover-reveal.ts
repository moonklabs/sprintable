/**
 * story #4345 — 행 호버로만 드러나던 조작 요소(문서 트리 «⋮» · 끌기 손잡이 · 삭제 ✕ 등)가 터치 기기에서는 늘 투명했고,
 * 키보드 초점이 가도 안 보였다(`hidden`이면 탭 순서에서 아예 빠졌다). 그 부류의 한 모양.
 * 기준은 폭이 아니라 «호버가 되는가»다(#4277 storage-asset-row 선례):
 * - 호버 없는 기기(터치 폰 · 태블릿 — 1024 이상 가로 포함)는 늘 보인다.
 * - 마우스(`pointer-fine`)만 숨겼다가 행 호버(`group-hover`) · 행 안 초점(`group-focus-within`) · 제 초점(`focus-within` — 자기 자신 포함)에서 보인다.
 * - `hidden`(display:none)으로 숨기지 않는다 — 탭 순서에서 빠져 키보드로 못 닿는다.
 * 행(부모)에 `group`이 있어야 한다. 부류 가드: `hover-reveal.guard.test.ts`.
 */
export const HOVER_REVEAL =
  'opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100 pointer-fine:focus-within:opacity-100';

/** 초점 링 — 디자인 Button과 같은 토큰(citron). Button이 아닌 raw 조작 요소에 단다. */
export const HOVER_REVEAL_FOCUS_RING = 'outline-none focus-visible:ring-3 focus-visible:ring-proof-citron';

/**
 * story #4345(PO · 유나 10:01Z) — 드러난 조작 요소의 누르는 자리 최소 24×24(아이콘은 그대로 · padding · 투명 상자로 키움).
 * 터치에서 늘 보이게 되면서 14~22px 자리가 손가락 오탭을 불렀다(첨부 ✕는 첨부 위에 겹쳐 있어 오탭 = 삭제).
 * 줄 높이가 바뀌면 안 되는 자리는 호출부가 음수 margin(`-my-1` 등)을 같이 준다. 부류 가드: hover-reveal.guard.test.ts 셋째 규칙.
 */
export const HOVER_REVEAL_HIT = 'inline-flex min-h-6 min-w-6 items-center justify-center';
