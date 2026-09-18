// @vitest-environment jsdom
//
// story #2969 §2 PR-4(doc proofline-system-layer-2969) — 오버레이는 shadow 대신
// --elev-overlay + proof-line-strong hairline을 항상 동반한다(§1.2).
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { Sheet, SheetContent, SheetTitle } from './sheet';
// story 3436(묶음 1) — SheetContent가 이제 useTranslations('common')을 쓴다
// (sr-only "Close" i18n화) — 렌더 트리에 NextIntlClientProvider가 있어야 한다.
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('SheetContent — --elev-overlay + proof-line-strong(story #2969 PR-4)', () => {
  it('열린 시트가 elev-overlay 그림자와 방향별 proof-line-strong 보더를 갖는다', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(
        <Sheet open>
          <SheetContent side="right">
            <SheetTitle>제목</SheetTitle>
          </SheetContent>
        </Sheet>,
      ));
    });
    const popup = document.querySelector('[data-slot="sheet-content"]');
    expect(popup).not.toBeNull();
    expect(popup?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(popup?.className).toContain('border-l-proof-line-strong');
    expect(popup?.className).not.toContain('shadow-lg');
  });

  // 카디르 QA독립검증(PR#3402) — right만 커버해 나머지 3방향(top/bottom/left) 뮤테이션에
  // 무영향이던 커버리지 갭. PR-5(#3402 이월분)에 편입.
  it.each(['top', 'bottom', 'left'] as const)(
    'side=%s도 그 방향의 proof-line-strong 보더를 갖는다(3방 커버리지 보강)',
    async (side) => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root.render(wrap(
          <Sheet open>
            <SheetContent side={side}>
              <SheetTitle>제목</SheetTitle>
            </SheetContent>
          </Sheet>,
        ));
      });
      const popup = document.querySelector('[data-slot="sheet-content"]');
      expect(popup).not.toBeNull();
      // 시트가 슬라이드해 들어오는 방향의 "반대편"(콘텐츠와 맞닿는 안쪽 모서리)에 hairline이
      // 선다 — top 시트는 아래쪽(border-b)·bottom 시트는 위쪽(border-t)·left 시트는
      // 오른쪽(border-r)이 콘텐츠 접면(sheet.tsx의 data-[side=X]:border-* 매핑과 동일).
      const borderSideClass = side === 'top' ? 'border-b-proof-line-strong'
        : side === 'bottom' ? 'border-t-proof-line-strong'
        : 'border-r-proof-line-strong';
      expect(popup?.className).toContain(borderSideClass);
    },
  );
});

// story 3436(묶음 1) — sr-only "Close" 하드코딩 정정(dialog.tsx와 같은 결함).
describe('SheetContent — 닫기 버튼 sr-only 접근 이름(story 3436)', () => {
  it('⭐기본(showCloseButton) 닫기 버튼의 sr-only 텍스트가 한국어다', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(
        <Sheet open>
          <SheetContent side="right">
            <SheetTitle>제목</SheetTitle>
          </SheetContent>
        </Sheet>,
      ));
    });
    const closeBtn = document.querySelector('[data-slot="sheet-close"]');
    expect(closeBtn?.querySelector('.sr-only')?.textContent).toBe(koMessages.common.close);
    expect(closeBtn?.textContent).not.toContain('Close');
  });
});
