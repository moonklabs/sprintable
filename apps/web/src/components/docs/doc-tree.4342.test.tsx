// @vitest-environment jsdom
//
// story #4342 — 좁은 화면에서 문서 트리 행 메뉴가 뷰포트 왼쪽 밖으로 나가지 않게 민다.
// story #4349 AC5부터 메뉴는 **열릴 때만** body로 포털된다(`AnchoredPopover` · 같은 4342 클램프). 그래서 «열릴 때 다시 잰다»는
// 약속은 «닫혀 있으면 없고 · 열리는 순간 재서 민다»가 된다. jsdom은 배치를 안 해서 패널 사각형을 값으로 둔다(왼쪽으로 40px 넘친 192px).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DocTree } from './doc-tree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const open = this.getAttribute('data-dropdown-panel') === 'doc-tree-menu';
    const r = open ? { left: -40, right: 152, width: 192 } : { left: 0, right: 0, width: 0 };
    return { ...r, top: 0, bottom: 0, height: open ? 120 : 0, x: r.left, y: 0, toJSON: () => r } as DOMRect;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DocTree 행 메뉴 — 열릴 때 재서 뷰포트 안으로(story #4342 · #4349 포털)', () => {
  it('닫혀 있으면 메뉴 0, 열리면 body 직속으로 붙고 왼쪽 넘침 40px → 여백 8px까지 translateX(48px)', () => {
    const doc = { id: 'd1', parent_id: null, title: '회의록', slug: 'd1', icon: null, sort_order: 0 };
    act(() => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DocTree docs={[doc]} selectedSlug={null} onSelect={() => {}} onDelete={async () => {}} projectId="p1" />
        </NextIntlClientProvider>,
      );
    });
    expect(document.querySelector('[data-dropdown-panel="doc-tree-menu"]')).toBeNull();
    const row = container.querySelector<HTMLButtonElement>('[data-doc-id="d1"]')!;
    act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
    const menu = document.querySelector<HTMLElement>('[data-dropdown-panel="doc-tree-menu"]')!;
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.transform).toBe('translateX(48px)');
  });
});
