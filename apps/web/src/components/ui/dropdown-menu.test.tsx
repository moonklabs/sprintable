// @vitest-environment jsdom
//
// story #2969 §2 PR-4(doc proofline-system-layer-2969) — 오버레이는 shadow 대신
// --elev-overlay + proof-line-strong hairline을 항상 동반한다(§1.2).
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSubContent } from './dropdown-menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('DropdownMenuContent — --elev-overlay + proof-line-strong(story #2969 PR-4)', () => {
  it('열린 메뉴 팝업이 elev-overlay 그림자와 proof-line-strong 링을 갖는다', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <DropdownMenu open>
          <DropdownMenuTrigger>열기</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>항목</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );
    });
    const popup = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(popup).not.toBeNull();
    expect(popup?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(popup?.className).toContain('ring-proof-line-strong');
    expect(popup?.className).not.toContain('ring-foreground/10');
    expect(popup?.className).not.toContain('shadow-md');
  });

  // 카디르 QA독립검증(PR#3402) — DropdownMenuSubContent가 무테스트였던 커버리지 갭.
  // PR-5(#3402 이월분)에 편입.
  it('열린 서브메뉴 팝업도 elev-overlay 그림자와 proof-line-strong 링을 갖는다', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <DropdownMenu open>
          <DropdownMenuTrigger>열기</DropdownMenuTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>서브 항목</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenu>,
      );
    });
    const popup = document.querySelector('[data-slot="dropdown-menu-sub-content"]');
    expect(popup).not.toBeNull();
    expect(popup?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(popup?.className).toContain('ring-proof-line-strong');
    expect(popup?.className).not.toContain('ring-foreground/10');
    expect(popup?.className).not.toContain('shadow-lg');
  });
});
