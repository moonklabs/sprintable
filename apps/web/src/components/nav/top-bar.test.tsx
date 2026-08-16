// @vitest-environment jsdom
//
// story #2683(모바일 IA S3) — settings/page.tsx 안에만 있던 전역 GNB 유일문(SidebarTrigger)을
// 폐기하며 태블릿(768~1023)만을 위한 새 문을 top-bar.tsx로 옮겼다(doc §2.6① PO 승인 권고).
// 이 트리거가 태블릿에서만 뜨고 폰·데스크톱에서는 없는지(폰=Sheet GNB 폐기, 데스크톱=이미
// 도킹 사이드바가 상시 보임이라 트리거 불필요) 실 렌더로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stubViewport(width: number) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {} }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
}

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubFetch();
  stubLocalStorage();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(width: number) {
  stubViewport(width);
  const { TopBar } = await import('./top-bar');
  const { TopBarProvider } = await import('./top-bar-context');
  const { SidebarProvider } = await import('@/components/ui/sidebar');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <SidebarProvider>
            <TopBar />
          </SidebarProvider>
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('TopBar — story #2683 태블릿 전용 GNB 트리거', () => {
  it('태블릿(768px)에서는 트리거가 뜬다', async () => {
    vi.resetModules();
    await mount(768);
    expect(container.querySelector('[data-slot="sidebar-trigger"]')).not.toBeNull();
  });

  it('폰(375px)에서는 트리거가 없다(Sheet GNB 폐기, doc §2.6①)', async () => {
    vi.resetModules();
    await mount(375);
    expect(container.querySelector('[data-slot="sidebar-trigger"]')).toBeNull();
  });

  it('데스크톱(1280px)에서는 트리거가 없다(도킹 사이드바 상시 노출)', async () => {
    vi.resetModules();
    await mount(1280);
    expect(container.querySelector('[data-slot="sidebar-trigger"]')).toBeNull();
  });
});
