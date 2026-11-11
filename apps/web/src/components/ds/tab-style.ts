/**
 * UI-3(a9d56577) 탭 한 칸의 모양 — Tabs(칸 패널)와 TabNav(이동 링크)가 같은 모양을 쓴다(정의 하나).
 * 높이 32 · 글자 card-title · 켜짐 = `action-text` 글 + 아래 2px `action` 밑줄(폰 3px) · 꺼짐 = `ink-3`(호버 `ink`) · 초점 링 2px 안쪽(inset — 줄의 overflow 클립이 바깥 링을 자르지 않게) · 폰은 누름 영역 44.
 * `-mb-px`: 켜진 밑줄이 바깥 아래 선 위에 겹쳐 «선 + 밑줄»이 두 겹 두께가 되지 않는다(줄의 overflow 클립이 1px을 잘라 밑줄이 선 바로 위에서 끝난다 — 기존 탭줄과 같다).
 * 켜짐을 색만으로 말하지 않는다 — 밑줄(모양) + 굵기가 같이 바뀐다(꺼짐 400 → 켜짐 600).
 */
export const TAB_BASE =
  'relative -mb-px inline-flex min-h-ds-compact shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-1 text-ds-card-title font-normal text-ds-ink-3 outline-none ' +
  'transition-colors duration-(--ds-duration-fast) motion-reduce:transition-none hover:text-ds-ink ' +
  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ds-action ' +
  'touch:min-h-ds-touch touch:border-b-3 disabled:pointer-events-none disabled:text-ds-ink-3 aria-disabled:pointer-events-none';

export const TAB_ACTIVE = 'border-ds-action font-semibold text-ds-action-text hover:text-ds-action-text';

/** Base UI 탭은 켜짐을 `data-active` 속성으로 알린다 — 같은 모양을 속성 변형으로. */
export const TAB_ACTIVE_DATA =
  'data-active:border-ds-action data-active:font-semibold data-active:text-ds-action-text data-active:hover:text-ds-action-text';

/** 줄 바깥 틀: 아래 선은 바깥 래퍼에 둔다(오른쪽 끝 흐림 mask가 선까지 옅게 하지 않게). */
export const TAB_RULE = 'border-b border-ds-line';

/** 가로 스크롤 줄 — 탭은 줄바꿈 · 축소 없이 제 폭, 스크롤바는 숨기고, 오른쪽 끝에서 흐려져 «더 있음»을 보인다(story #4277). */
export const TAB_STRIP =
  'flex items-end gap-4 overflow-x-auto overflow-y-hidden pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]';
