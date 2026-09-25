// @vitest-environment jsdom
//
// [SID:4288 · 까디르 4653 P2 재판정] 데스크톱 오프캔버스로 접힌 사이드바 — 화면 밖 내용 칸(머리 · 내용 · 바닥)만 inert이고, 레일(다시 펴기
// · 크기 조절)은 inert 밖이라 눌러서 다시 편다. 컨테이너 통째에 inert를 걸면 레일까지 죽던 회귀의 가드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarProvider, SidebarRail,
} from './sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 }); // 데스크톱 분기
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function render(defaultOpen: boolean, collapsible: 'offcanvas' | 'icon' = 'offcanvas') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <SidebarProvider defaultOpen={defaultOpen}>
          <Sidebar collapsible={collapsible}>
            <SidebarHeader><button type="button">머리</button></SidebarHeader>
            <SidebarContent><button type="button">내용</button></SidebarContent>
            <SidebarFooter><button type="button">바닥</button></SidebarFooter>
            <SidebarRail />
          </Sidebar>
        </SidebarProvider>
      </NextIntlClientProvider>,
    );
  });
}

const slot = (name: string) => container.querySelector(`[data-slot="${name}"]`)!;
const rail = () => container.querySelector('[data-sidebar="rail"]') as HTMLButtonElement;

describe('Sidebar — 오프캔버스 접힘은 내용 칸만 inert · 레일은 살아 있음([SID:4288])', () => {
  it('접힘(오프캔버스) → 머리 · 내용 · 바닥 inert, 컨테이너 · 레일은 inert 밖', async () => {
    await render(false);
    for (const name of ['sidebar-header', 'sidebar-content', 'sidebar-footer']) {
      expect(slot(name).hasAttribute('inert'), name).toBe(true);
    }
    expect(slot('sidebar-container').hasAttribute('inert')).toBe(false);
    expect(rail()).not.toBeNull();
    expect(rail().closest('[inert]')).toBeNull();
  });

  it('레일을 누르면 다시 펴지고 inert가 풀린다', async () => {
    await render(false);
    await act(async () => { rail().click(); });
    expect(container.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state')).toBe('expanded');
    for (const name of ['sidebar-header', 'sidebar-content', 'sidebar-footer']) {
      expect(slot(name).hasAttribute('inert'), name).toBe(false);
    }
  });

  it('펼침 · 아이콘 접힘(화면 안)은 inert 없음', async () => {
    await render(true);
    expect(slot('sidebar-content').hasAttribute('inert')).toBe(false);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render(false, 'icon');
    expect(slot('sidebar-content').hasAttribute('inert')).toBe(false);
  });
});
