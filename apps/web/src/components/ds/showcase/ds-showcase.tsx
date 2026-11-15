'use client';

import { useState } from 'react';
import { DsPortalContainer } from '../portal-container';
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

/**
 * 밝음 · 어둠 나란히(좁은 화면은 위아래). 어둠 쪽은 `.dark` 감싸개 — 토큰이 `.dark`에서 다시 정의된다. 밝음 틀은 `.ds-theme-light`로 밝음 값을 다시 걸어 어두운 화면에서도 밝게 보인다.
 * 팝업(대화창 · 패널 · 메뉴 · 날짜 팝업)은 `DsPortalContainer`로 «그 틀 안»에 그려져 틀의 테마를 따른다(화면 가장자리 `body`에 그리면 앱 테마를 따라 어둠 틀의 팝업이 밝게 뜰 수 있다).
 */
export function ShowcaseFrame({ today }: { today: string }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ThemeFrame theme="light" title="밝음" today={today} className="ds-theme-light" />
      <ThemeFrame theme="dark" title="어둠" today={today} className="dark" />
    </div>
  );
}

function ThemeFrame({ theme, title, today, className }: { theme: 'light' | 'dark'; title: string; today: string; className: string }) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setFrame} data-theme-frame={theme} className={`${className} min-w-0 rounded-ds-panel border border-ds-line bg-ds-background p-4 text-ds-ink`}>
      <h2 className="m-0 mb-3 text-ds-title font-semibold">{title}</h2>
      <DsPortalContainer container={frame}>
        <DsShowcase today={today} />
      </DsPortalContainer>
    </div>
  );
}
