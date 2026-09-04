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
