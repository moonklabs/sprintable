// @vitest-environment jsdom
// story #4306(PO 10:23Z) — MenuSearchInput 단위: 체크/라디오 항목만 있는 메뉴에서도 ↓가 첫 항목으로 가고, IME 조합 중(한국어) ↓는 무시한다.
// 보드 필터 네 메뉴의 렌더 동작은 kanban-board.test.tsx가 잰다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MenuSearchInput } from './menu-search-input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const frames = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
  }
};

async function open(items: React.ReactNode) {
  await act(async () => {
    root.render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<button type="button">open</button>} />
        <DropdownMenuContent>
          <MenuSearchInput placeholder="검색..." value="" onChange={() => {}} />
          {items}
        </DropdownMenuContent>
      </DropdownMenu>,
    );
  });
  const trigger = container.querySelector('button')!;
  await act(async () => { trigger.focus(); trigger.click(); });
  await frames();
  const input = document.activeElement as HTMLInputElement;
  expect(input.placeholder).toBe('검색...');
  return input;
}

const press = async (el: HTMLElement, init: KeyboardEventInit & { keyCode?: number }) => {
  await act(async () => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    if (init.keyCode !== undefined) Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
    el.dispatchEvent(ev);
  });
  await frames();
};

describe('MenuSearchInput(story #4306)', () => {
  it('⭐체크 항목만 있는 메뉴 — ↓가 첫 체크 항목으로 · 그 항목에서 ↑ = 검색칸', async () => {
    const input = await open(<>
      <DropdownMenuCheckboxItem checked={false}>라벨 A</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem checked>라벨 B</DropdownMenuCheckboxItem>
    </>);
    await press(input, { key: 'ArrowDown' });
    const first = document.activeElement as HTMLElement;
    expect(first.getAttribute('role')).toBe('menuitemcheckbox');
    expect(first.textContent).toContain('라벨 A');
    await press(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(input);
  });

  it.each([
    ['isComposing', { key: 'ArrowDown', isComposing: true }],
    ['keyCode 229', { key: 'ArrowDown', keyCode: 229 }],
  ] as const)('⭐IME 조합 중(%s) ↓는 무시 — 초점 검색칸 그대로', async (_label, init) => {
    const input = await open(<DropdownMenuItem>항목</DropdownMenuItem>);
    await press(input, init);
    expect(document.activeElement).toBe(input);
  });
});
