// @vitest-environment jsdom
//
// story #4342 — 문서 트리 행 메뉴는 늘 붙어 있고 클래스(`hidden` ↔ `block`)로만 숨는다. 그래서 붙는 순간(숨은 채 · 폭 0)엔 잴 게 없고,
// **열릴 때 다시 재야** 좁은 화면에서 뷰포트 안으로 밀려 들어간다 — 열림 상태를 훅에 넘기는 까닭(뮤테이션 V8이 이 자리를 놓쳐 넣은 테스트).
// jsdom은 배치를 안 해서 패널 사각형을 값으로 둔다(보이면 왼쪽으로 40px 넘친 192px · 숨으면 0).
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
    const open = this.getAttribute('data-dropdown-panel') === 'doc-tree-menu' && !this.classList.contains('hidden');
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

describe('DocTree 행 메뉴 — 열릴 때 다시 재서 뷰포트 안으로(story #4342)', () => {
  it('붙을 땐(숨은 채) 안 밀고, 열리면 왼쪽 넘침 40px → 여백 8px까지 translateX(48px)', () => {
    const doc = { id: 'd1', parent_id: null, title: '회의록', slug: 'd1', icon: null, sort_order: 0 };
    act(() => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DocTree docs={[doc]} selectedSlug={null} onSelect={() => {}} onDelete={async () => {}} projectId="p1" />
        </NextIntlClientProvider>,
      );
    });
    const menu = container.querySelector<HTMLElement>('[data-dropdown-panel="doc-tree-menu"]')!;
    expect(menu.classList.contains('hidden')).toBe(true);
    expect(menu.style.transform).toBe('');
    const row = container.querySelector<HTMLButtonElement>('[data-doc-id="d1"]')!;
    act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
    expect(menu.classList.contains('hidden')).toBe(false);
    expect(menu.style.transform).toBe('translateX(48px)');
  });
});
