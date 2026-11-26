/**
 * UI-3(a9d56577) 탭 한 칸의 모양 — Tabs(칸 패널)와 TabNav(이동 링크)가 같은 모양을 쓴다(정의 하나).
 * story 5048 T0 ②b(키트 결): 높이 40 · 좌우 16 · 모서리 8 · 글자 16 Medium · 꺼짐 = `ink-3`(호버 `ink`) · **켜짐 = 면 채움(`surface-sunk`) + 본문 글자 + 굵기 600** — 밑줄 대신 «면» 하나(색만으로 말하지 않는다: 면 + 굵기).
 * 초점 링 2px 안쪽(inset — 줄의 overflow 클립이 바깥 링을 자르지 않게) · 폰은 누름 영역 44.
 */
export const TAB_BASE =
  'relative inline-flex min-h-ds-control shrink-0 items-center justify-center gap-ds-2 whitespace-nowrap rounded-ds-control border border-transparent px-ds-4 text-ds-body font-medium text-ds-ink-3 outline-none ' +
  'transition-colors duration-(--ds-duration-fast) motion-reduce:transition-none hover:text-ds-ink ' +
  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ds-action ' +
  'touch:min-h-ds-touch disabled:pointer-events-none disabled:text-ds-ink-3 aria-disabled:pointer-events-none';

export const TAB_ACTIVE = 'bg-ds-surface-sunk font-semibold text-ds-ink hover:text-ds-ink';

/** Base UI 탭은 켜짐을 `data-active` 속성으로 알린다 — 같은 모양을 속성 변형으로. */
export const TAB_ACTIVE_DATA =
  'data-active:bg-ds-surface-sunk data-active:font-semibold data-active:text-ds-ink data-active:hover:text-ds-ink';

/** 줄 바깥 틀: 아래 선은 바깥 래퍼에 둔다(오른쪽 끝 흐림 mask가 선까지 옅게 하지 않게). */
export const TAB_RULE = 'border-b border-ds-line';

/** 가로 스크롤 줄 — 탭은 줄바꿈 · 축소 없이 제 폭, 스크롤바는 숨기고, 오른쪽 끝에서 흐려져 «더 있음»을 보인다(story #4277). 칸 사이 4(키트 간격). */
export const TAB_STRIP =
  'flex items-center gap-ds-1 overflow-x-auto overflow-y-hidden py-ds-1 pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]';

/**
 * story 5048 T0 ②b — 큰 제목 탭(BigTabs): 키트의 «24 Semibold 제목이 곧 탭». 고른 것 = 본문 글자색 · 나머지 = 셋째 글자색(면 · 밑줄 없음 — 켜짐은 색 + 호버/초점 링).
 * 켜짐을 색만으로 말하지 않게 `aria-selected`(Base UI)가 의미를 싣고, 모양은 «진한 글자 vs 옅은 글자»로 갈린다(둘의 대비 차이 + 고른 쪽만 굵기 700 대신 같은 600 — 위계는 색).
 */
export const BIG_TAB_BASE =
  'relative inline-flex min-h-ds-control shrink-0 items-center justify-center whitespace-nowrap rounded-ds-control px-ds-2 text-ds-title text-ds-ink-3 outline-none ' +
  'transition-colors duration-(--ds-duration-fast) motion-reduce:transition-none hover:text-ds-ink ' +
  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ds-action touch:min-h-ds-touch disabled:pointer-events-none disabled:text-ds-ink-3';
export const BIG_TAB_ACTIVE_DATA = 'data-active:text-ds-ink data-active:hover:text-ds-ink';
