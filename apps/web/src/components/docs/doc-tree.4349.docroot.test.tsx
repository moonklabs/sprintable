// @vitest-environment jsdom
//
// story #4349(PO · 유나 13:10Z) — 실 앱(Next App Router)은 React 뿌리가 **document**다(hydrateRoot(document)). 서랍 초점 가두기는 document keydown
// 네이티브 리스너라, «합성 stopPropagation이 같은 document에서 막히나»는 div 뿌리 시험으로는 못 본다 → 뿌리를 document에 두고 잰다.
// 실 키(헤드리스 Chromium) 판: 메뉴 안 Esc = 메뉴만 닫힘 · 서랍 열린 채(React가 포털 그릇(body)에도 귀 기울여 body에서 멈춤).
// 곁 결함(같은 판에서 잡음): «⋮»에서 Enter로 열면 Chromium이 Enter 활성화(keypress → click)를 이미 옮긴 초점(첫 항목)에 보내 «이름 변경»이
// 곧바로 눌렸다 → 트리거 keydown에서 기본 동작을 막는다(여기선 defaultPrevented로 못박음 · jsdom은 keypress를 안 만든다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DocTree } from './doc-tree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC = { id: 'd1', parent_id: null, title: '회의록', slug: 'd1', icon: null, sort_order: 0 };
let root: Root | null = null;

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountOnDocument() {
  vi.spyOn(console, 'error').mockImplementation(() => {}); // 서버 마크업이 없어 생기는 hydration 불일치 경고(뒤 클라이언트 렌더로 복구)
  act(() => {
    root = hydrateRoot(document, (
      <html lang="ko"><head /><body>
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <div id="drawer" className="overflow-hidden"><DocTree docs={[DOC]} selectedSlug={null} onSelect={() => {}} onDelete={async () => {}} projectId="p1" /></div>
        </NextIntlClientProvider>
      </body></html>
    ), { onRecoverableError: () => {} });
  });
}
const trigger = () => Array.from(document.querySelector('[data-doc-id="d1"]')!.parentElement!.querySelectorAll<HTMLElement>(':scope > div[role="button"]')).at(-1)!;
const menu = () => document.querySelector<HTMLElement>('[data-dropdown-panel="doc-tree-menu"]');
const key = (el: Element, k: string) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(e); });
  return e;
};

describe('DocTree 행 메뉴 — React 뿌리가 document일 때(Next App Router 모양 · story #4349)', () => {
  it('뿌리가 정말 document다(대조) · 메뉴 안 Esc는 메뉴만 닫고 document 네이티브 리스너(서랍 트랩)까지 안 간다', () => {
    mountOnDocument();
    expect(Object.keys(document).some((k) => k.startsWith('__reactContainer'))).toBe(true);
    const drawerTrap = vi.fn();
    document.addEventListener('keydown', drawerTrap);
    trigger().focus();
    key(trigger(), 'Enter');
    expect(menu()).not.toBeNull();
    const item = menu()!.querySelector('button')!;
    expect(document.activeElement).toBe(item);
    key(item, 'Escape');
    document.removeEventListener('keydown', drawerTrap);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(drawerTrap.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape')).toHaveLength(0);
  });

  it('«⋮»에서 Enter · Space로 열 때 기본 동작을 막는다(열린 첫 항목이 Enter 활성화로 곧바로 눌리지 않게)', () => {
    mountOnDocument();
    trigger().focus();
    expect(key(trigger(), 'Enter').defaultPrevented).toBe(true);
    key(menu()!.querySelector('button')!, 'Escape');
    expect(key(trigger(), ' ').defaultPrevented).toBe(true);
  });
});
