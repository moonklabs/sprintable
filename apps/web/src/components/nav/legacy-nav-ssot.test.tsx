// @vitest-environment jsdom
//
// story #3836(UX-v3·셸 후속, PO 確定 2026-09-14) AC2/AC3 — 사이드바 「더보기」·⌘K 팔레트·
// 모바일 /more 「그 밖의 화면」 세 소비처가 nav-config.ts 한 곳(LEGACY_NAV_ITEMS)에서
// 파생된다는 것을 실 렌더로 대조한다. vi.doMock + vi.resetModules로 같은 파일 안에서
// nav-config 모듈을 두 상태(항목 있음/없음)로 갈아 끼워, 어느 한 소비처가 자기만의
// 하드코딩 목록으로 되돌아가면 그 소비처만 옛 항목을 계속 보여줘 이 테스트가 RED가 되게
// 한다(AC3 "한 곳만 하드코딩하면 RED").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { LucideIcon } from 'lucide-react';
import { Layers } from 'lucide-react';
import koMessages from '../../../messages/ko.json';

const FAKE_ICON = Layers as LucideIcon;

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/dashboard' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STABLE_ITEM = { id: 'fake-stable', labelKey: 'goals', descriptionKey: 'descGoals', icon: FAKE_ICON, kind: 'static' as const, path: '/fake-stable' };
const MUTABLE_ITEM = { id: 'fake-mutable', labelKey: 'loops', descriptionKey: 'descLoops', icon: FAKE_ICON, kind: 'static' as const, path: '/fake-mutable' };

function fakeNavConfigModule(includeMutable: boolean) {
  const items = includeMutable ? [STABLE_ITEM, MUTABLE_ITEM] : [STABLE_ITEM];
  return {
    NAV_GROUPS: [],
    MOBILE_HUB_GROUP_ORDER: [],
    MOBILE_HUB_EXCLUDE_IDS: new Set<string>(),
    LEGACY_NAV_ITEMS: items,
    VISIBLE_LEGACY_NAV_ITEMS: items,
    CHAT_CENTER_ITEM: { id: 'chats', labelKey: 'chats', descriptionKey: 'descChats', icon: FAKE_ICON, kind: 'static' as const, path: '/chats' },
  };
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let containers: HTMLDivElement[] = [];
let roots: Root[] = [];

function makeRoot() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  containers.push(el);
  roots.push(root);
  return { el, root };
}

beforeEach(() => {
  pathnameRef.current = '/dashboard';
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
});

afterEach(async () => {
  for (const r of roots) await act(async () => { r.unmount(); });
  for (const el of containers) el.remove();
  containers = [];
  roots = [];
  vi.unstubAllGlobals();
  vi.doUnmock('@/lib/nav-config');
  vi.resetModules();
});

async function renderAll(includeMutable: boolean) {
  vi.resetModules();
  vi.doMock('@/lib/nav-config', () => fakeNavConfigModule(includeMutable));

  const { AppSidebar } = await import('./app-sidebar');
  const { SidebarProvider } = await import('@/components/ui/sidebar');
  const { default: MorePage } = await import('@/app/(authenticated)/more/page');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  const { CommandPalette } = await import('@/components/command-palette/command-palette');

  // 사이드바 — 「더보기」를 미리 펼쳐(localStorage 시드) 항목이 DOM에 실리게 한다(AC1
  // 기본 접힘은 별도 스위트에서 이미 검증, 여기 관심사는 집합 일치뿐).
  localStorage.setItem('sidebar_group_collapsed', JSON.stringify({ legacy: false }));
  const sidebar = makeRoot();
  await act(async () => {
    sidebar.root.render(wrap(
      <SidebarProvider><AppSidebar projectMemberships={[]} chatUnreadTotal={0} /></SidebarProvider>,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const more = makeRoot();
  await act(async () => {
    more.root.render(wrap(<TopBarProvider><MorePage /></TopBarProvider>));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const palette = makeRoot();
  await act(async () => {
    palette.root.render(wrap(<CommandPalette open onOpenChange={vi.fn()} />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const sidebarIds = new Set(
    [...sidebar.el.querySelectorAll('a[data-legacy-nav-id]')].map((a) => a.getAttribute('data-legacy-nav-id')),
  );
  const moreIds = new Set(
    [...more.el.querySelectorAll('a')]
      .map((a) => a.getAttribute('href'))
      .filter((href): href is string => !!href && href.startsWith('/fake-')),
  );
  // DialogPrimitive.Portal이 palette.el이 아니라 document.body 직속으로 렌더한다
  // (command-palette.test.tsx의 기존 관례와 동일 — 전역 document 조회).
  const paletteIds = new Set(
    [...document.querySelectorAll('[data-command-id]')].map((el) => el.getAttribute('data-command-id')),
  );

  return { sidebarIds, moreIds, paletteIds };
}

describe('LEGACY_NAV_ITEMS SSOT — 사이드바 「더보기」·⌘K 팔레트·모바일 /more 3-way 대조(story #3836 AC2/AC3)', () => {
  it('두 항목 모두 있을 때 세 소비처 전부에 mutable 항목이 보인다(양성대조)', async () => {
    const { sidebarIds, moreIds, paletteIds } = await renderAll(true);
    expect(sidebarIds.has('fake-mutable')).toBe(true);
    expect(moreIds.has('/fake-mutable')).toBe(true);
    expect(paletteIds.has('fake-mutable')).toBe(true);
  });

  it('nav-config에서 mutable 항목 하나를 빼면 세 소비처 전부에서 동시에 사라진다(한 곳만 하드코딩이면 이 테스트가 RED)', async () => {
    const { sidebarIds, moreIds, paletteIds } = await renderAll(false);
    expect(sidebarIds.has('fake-mutable')).toBe(false);
    expect(moreIds.has('/fake-mutable')).toBe(false);
    expect(paletteIds.has('fake-mutable')).toBe(false);
    // stable 항목은 그대로 남아 있어야(과다삭제 아님을 확인 — 뮤테이션이 "전부 지움"으로
    // 위장 통과하는 것을 막는 양성대조).
    expect(sidebarIds.has('fake-stable')).toBe(true);
    expect(moreIds.has('/fake-stable')).toBe(true);
    expect(paletteIds.has('fake-stable')).toBe(true);
  });
});
