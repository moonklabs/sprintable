'use client';

import { ShowcasePartsA } from './showcase-parts-a';
import { ShowcasePartsB } from './showcase-parts-b';
import { ShowcaseTokens } from './showcase-tokens';

/** 한 테마의 견본 전체 — 토큰 + 부품. 밝음/어둠은 바깥 틀(`ShowcaseFrame`)이 가른다. */
export function DsShowcase({ today }: { today: string }) {
  return (
    <div data-slot="ds-showcase" className="min-w-0">
      <ShowcaseTokens />
      <ShowcasePartsA />
      <ShowcasePartsB today={today} />
    </div>
  );
}

/** 밝음 · 어둠 나란히(좁은 화면은 위아래). 어둠 쪽은 `.dark` 감싸개 — 토큰이 `.dark`에서 다시 정의된다. 밝음 틀은 `.ds-theme-light`로 밝음 값을 다시 걸어 어두운 화면에서도 밝게 보인다. 팝업(대화창 · 메뉴)은 화면 가장자리에 그려져 화면 테마를 따른다(견본 안내 글에 적힌 한계). */
export function ShowcaseFrame({ today }: { today: string }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div data-theme-frame="light" className="ds-theme-light min-w-0 rounded-ds-panel border border-ds-line bg-ds-background p-4 text-ds-ink">
        <h2 className="m-0 mb-3 text-ds-title font-semibold">밝음</h2>
        <DsShowcase today={today} />
      </div>
      <div data-theme-frame="dark" className="dark min-w-0 rounded-ds-panel border border-ds-line bg-ds-background p-4 text-ds-ink">
        <h2 className="m-0 mb-3 text-ds-title font-semibold">어둠</h2>
        <DsShowcase today={today} />
      </div>
    </div>
  );
}
