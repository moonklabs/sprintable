// @vitest-environment jsdom
//
// story #2969 §2 PR-4(doc proofline-system-layer-2969) — 오버레이는 shadow 대신
// --elev-overlay + proof-line-strong hairline을 항상 동반한다(§1.2).
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Dialog, DialogContent, DialogTitle } from './dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
      root.render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>제목</DialogTitle>
          </DialogContent>
        </Dialog>,
      );
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
