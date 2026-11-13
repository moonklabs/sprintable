// @vitest-environment jsdom
//
// 4910 스토리지 마무리 — 폰의 «전체 자산 ⌄» 폴더 고르기 단추가 옛 `ui/button`(variant outline = bg-background 옛 미색)이라 페이지 바탕 위에 미색 한 덩이로 앉던 것(cap-final 폰 픽셀 (247,246,243) vs 바탕 (243,245,249))을
// ds 부품으로 바꿨다. 서랍의 닫기 단추도 같이. 이 시험은 «ds 부품이고 옛 토큰이 없다»를 지킨다(되돌리면 RED). 실제 StorageView + 실제 서랍.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/x/storage' }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectName: '프로젝트' }) }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('./storage-capacity-banner', () => ({ StorageCapacityBanner: () => null }));
vi.mock('./storage-uploader-avatar', () => ({ StorageUploaderAvatar: () => <span /> }));
vi.mock('./storage-thumbnail', () => ({ StorageThumbnail: () => <span /> }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) }));

import { StorageView } from './storage-view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } } as Storage;
}
function setInline(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { items: [], next_cursor: null } }), { status: 200 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setInline(false);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><StorageView projectId="p1" /></NextIntlClientProvider>); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('폰 폴더 고르기 단추 · 서랍 닫기 단추 (4910 스토리지 마무리)', () => {
  it('⭐«전체 자산 ⌄» 단추는 ds 부품(data-slot ds-button · 보조형)이고 옛 ui 부품의 미색 토큰(bg-background · bg-input)이 없다 · 누름 영역 44는 그대로', async () => {
    await render();
    const trigger = container.querySelector<HTMLElement>('[data-testid="storage-folder-drawer-trigger"]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute('data-slot')).toBe('ds-button');
    const cls = trigger.className.split(/\s+/);
    expect(cls).toContain('bg-transparent'); // 보조형 = 바탕 위에 그대로 앉는다(미색 덩이 없음)
    expect(cls).toContain('border-ds-line-control');
    expect(cls.some((c) => /^(dark:)?bg-(background|input)(\/|$)/.test(c) || c === 'bg-background')).toBe(false);
    expect(cls).toContain('min-h-[44px]');
  });

  it('⭐동작: 서랍은 처음에 닫힘(aria-hidden · inert) → «전체 자산» 단추가 열고 → 닫기 단추(ds IconButton · 이름 «닫기»)가 닫는다 · 두 단추 모두 type=button', async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="storage-folder-drawer-trigger"]')!;
    const drawer = () => container.ownerDocument.querySelector<HTMLElement>('[data-testid="storage-folder-drawer"]')!;
    const isClosed = () => drawer().getAttribute('aria-hidden') === 'true' && drawer().hasAttribute('inert');
    expect(isClosed()).toBe(true); // 서랍은 늘 붙어 있다 — 열림 여부는 aria-hidden · inert
    expect(trigger.type).toBe('button');
    await act(async () => { trigger.click(); });
    expect(isClosed()).toBe(false); // 단추가 연다(onClick을 떼면 RED)
    const close = drawer().querySelector<HTMLButtonElement>('[data-slot="ds-icon-button"]')!;
    expect(close).not.toBeNull();
    expect(close.getAttribute('aria-label')).toBe('닫기');
    expect(close.type).toBe('button');
    expect(drawer().querySelector('[data-slot="button"]')).toBeNull(); // 옛 ui 부품 단추가 서랍 머리에 안 남는다
    await act(async () => { close.click(); });
    expect(isClosed()).toBe(true); // 닫기 단추가 닫는다(onClick을 떼면 RED)
  });
});
