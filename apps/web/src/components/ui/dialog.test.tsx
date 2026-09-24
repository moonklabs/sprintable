// @vitest-environment jsdom
//
// story #2969 §2 PR-4(doc proofline-system-layer-2969) — 오버레이는 shadow 대신
// --elev-overlay + proof-line-strong hairline을 항상 동반한다(§1.2).
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { Dialog, DialogContent, DialogTitle } from './dialog';
// story 3436(묶음 1) — DialogContent가 이제 useTranslations('common')을 쓴다
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

describe('DialogContent — --elev-overlay + proof-line-strong(story #2969 PR-4)', () => {
  it('열린 다이얼로그 팝업이 elev-overlay 그림자와 proof-line-strong 링을 갖는다', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(
        <Dialog open>
          <DialogContent>
            <DialogTitle>제목</DialogTitle>
          </DialogContent>
        </Dialog>,
      ));
    });
    const popup = document.querySelector('[data-slot="dialog-content"]');
    expect(popup).not.toBeNull();
    expect(popup?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(popup?.className).toContain('ring-proof-line-strong');
    expect(popup?.className).not.toContain('ring-foreground/10');
    expect(popup?.className).toContain('rounded-lg');
    expect(popup?.className).not.toContain('rounded-xl');
  });
});

// story 3436(묶음 1) — sr-only "Close" 하드코딩 정정.
describe('DialogContent — 닫기 버튼 sr-only 접근 이름(story 3436)', () => {
  it('⭐기본(showCloseButton) 닫기 버튼의 sr-only 텍스트가 한국어다', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(
        <Dialog open>
          <DialogContent>
            <DialogTitle>제목</DialogTitle>
          </DialogContent>
        </Dialog>,
      ));
    });
    const closeBtn = document.querySelector('[data-slot="dialog-close"]');
    expect(closeBtn?.querySelector('.sr-only')?.textContent).toBe(koMessages.common.close);
    expect(closeBtn?.textContent).not.toContain('Close');
  });
});

// story #4210(유나 390 실측) — 공용 다이얼로그 390 규격(#4202가 두 다이얼로그에만 국소로 넣던 것을 공용으로 옮김):
// ① 내용 그리드 열 = minmax(0,1fr) — 넓은 자식(레시피 상세 스테퍼 1040px)이 다이얼로그를 가로로 넘기지 않게.
// ② 닫기(X)가 떠 있을 때만 제목 오른쪽을 비운다(pr-8) — 긴 제목이 X 밑으로 들어가지 않게.
describe('DialogContent·DialogTitle — 390 규격(story #4210)', () => {
  async function render(showCloseButton: boolean) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(
        <Dialog open>
          <DialogContent showCloseButton={showCloseButton}>
            <DialogTitle>긴 제목 Video production (Reels, Shorts) — Apply to project</DialogTitle>
          </DialogContent>
        </Dialog>,
      ));
    });
    const popup = document.body.querySelector('[data-slot="dialog-content"]') as HTMLElement;
    const title = document.body.querySelector('[data-slot="dialog-title"]') as HTMLElement;
    return { popup, title };
  }

  it('내용 그리드 열이 minmax(0,1fr) — 모든 다이얼로그에 공통', async () => {
    const { popup } = await render(true);
    expect(popup.className).toContain('grid-cols-[minmax(0,1fr)]');
  });

  it('⭐닫기 버튼이 있으면 팝업에 data-close-button 표지 · **첫 줄 전체**(첫 자식)가 그 표지로 pr-8 · 제목 자체엔 중복 pr-8 없음', async () => {
    const { popup, title } = await render(true);
    expect(popup.hasAttribute('data-close-button')).toBe(true);
    expect(popup.className).toContain('data-[close-button]:[&>*:first-child]:pr-8');
    expect(title.className).not.toContain('pr-8');
    // 닫기(X)는 children 뒤에 그린다 — 첫 자식은 늘 이 다이얼로그의 첫 줄(X가 아님).
    expect(popup.firstElementChild?.getAttribute('data-slot')).not.toBe('dialog-close');
    expect(popup.lastElementChild?.getAttribute('data-slot')).toBe('dialog-close');
  });

  it('닫기 버튼이 없으면 표지도 없다(제목 오른쪽을 비우지 않음)', async () => {
    const { popup } = await render(false);
    expect(popup.hasAttribute('data-close-button')).toBe(false);
  });
});
