// @vitest-environment jsdom
//
// story #2969 §2 PR-4(doc proofline-system-layer-2969) — 오버레이는 shadow 대신
// --elev-overlay + proof-line-strong hairline을 항상 동반한다(§1.2).
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sheet, SheetContent, SheetTitle } from './sheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
      root.render(
        <Sheet open>
          <SheetContent side="right">
            <SheetTitle>제목</SheetTitle>
          </SheetContent>
        </Sheet>,
      );
    });
    const popup = document.querySelector('[data-slot="sheet-content"]');
    expect(popup).not.toBeNull();
    expect(popup?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(popup?.className).toContain('border-l-proof-line-strong');
    expect(popup?.className).not.toContain('shadow-lg');
  });
});
