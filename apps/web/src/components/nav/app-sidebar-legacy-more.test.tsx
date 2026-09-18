// @vitest-environment jsdom
//
// story #3836(UX-v3·셸 후속, 선생님 지적 2026-09-14 00:47Z·PO 確定 00:49Z) AC1 — 데스크톱
// 사이드바 「더보기」 접힘 절 자체의 동작(기본 접힘·사람별 기억·항목 집합·순서·활성 시
// 자동 펼침). AC2/AC3(3-way SSOT 일치·뮤테이션)는 별도 파일(legacy-nav-ssot.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { VISIBLE_LEGACY_NAV_ITEMS, groupVisibleLegacyByTarget } from '@/lib/nav-config';

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/dashboard' } }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const { AppSidebar } = await import('./app-sidebar');
const { SidebarProvider } = await import('@/components/ui/sidebar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withProviders(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <SidebarProvider>{node}</SidebarProvider>
    </NextIntlClientProvider>
  );
}

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { count: 0 } }), {
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
  return store;
}

let container: HTMLDivElement;
let root: Root;
let storage: Map<string, string>;

beforeEach(() => {
  stubMatchMedia();
  stubFetch();
  storage = stubLocalStorage();
  pathnameRef.current = '/dashboard';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(withProviders(
      <AppSidebar projectMemberships={[]} chatUnreadTotal={0} />,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function moreToggle(): HTMLElement | undefined {
  return [...container.querySelectorAll('[data-slot="sidebar-group-label"]')]
    .find((el) => el.textContent === '더보기') as HTMLElement | undefined;
}

describe('AppSidebar — 「더보기」 접힘 절(story #3836 AC1)', () => {
  it('기억 없는 새 브라우저에선 기본 접힘이다(다른 4구역은 f81657f8대로 전부 펼침인 것과 대비)', async () => {
    await mount();
    const toggle = moreToggle();
    expect(toggle).toBeDefined();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    // 접힌 상태에선 항목 링크 자체가 DOM에 없다.
    expect(container.querySelector('a[data-legacy-nav-id]')).toBeNull();
  });

  it('토글을 누르면 펼쳐지고 localStorage에 기억된다', async () => {
    await mount();
    const toggle = moreToggle()!;
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(moreToggle()!.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('a[data-legacy-nav-id]').length).toBe(VISIBLE_LEGACY_NAV_ITEMS.length);
    const stored = JSON.parse(storage.get('sidebar_group_collapsed') ?? '{}');
    expect(stored.legacy).toBe(false);
  });

  it('펼침 기억이 있으면 다음 마운트에서도 펼쳐진 채로 시작한다', async () => {
    storage.set('sidebar_group_collapsed', JSON.stringify({ legacy: false }));
    await mount();
    expect(moreToggle()!.getAttribute('aria-expanded')).toBe('true');
  });

  // story #3855 — 렌더 순서는 이제 VISIBLE_LEGACY_NAV_ITEMS의 원 배열 순서가 아니라
  // groupVisibleLegacyByTarget()의 머리말별 묶음 순서다(일감→연결·규칙→지식→이력→설정,
  // 각 묶음 안에서는 기존 배열 순서 유지) — «갈 곳별로»가 이 카드의 핵심이라 그 자체가
  // 기대값이 된다(SSOT는 여전히 nav-config.ts 하나뿐, 이 테스트 파일이 손으로 다시 안 짬).
  it('펼쳤을 때 항목=groupVisibleLegacyByTarget()과 정확히 같은 id·순서(nav-config SSOT)', async () => {
    storage.set('sidebar_group_collapsed', JSON.stringify({ legacy: false }));
    await mount();
    const renderedIds = [...container.querySelectorAll('a[data-legacy-nav-id]')]
      .map((a) => a.getAttribute('data-legacy-nav-id'));
    const expectedIds = groupVisibleLegacyByTarget().flatMap((g) => g.items.map((i) => i.id));
    expect(renderedIds).toEqual(expectedIds);
    // 양성대조 — 그룹화 전 원 배열 순서와는 실제로 달라야 한다(테스트가 우연히
    // 통과하는 게 아님을 스스로 증명).
    expect(renderedIds).not.toEqual(VISIBLE_LEGACY_NAV_ITEMS.map((i) => i.id));
  });

  // story #3845(§④, 2026-09-14) — retro가 LEGACY_NAV_ITEMS에서 빠지며 17→16(nav-config.ts
  // 참고). 리터럴 대신 VISIBLE_LEGACY_NAV_ITEMS.length로 대조해 다음 흡수(standup)에도
  // 이 자리를 또 안 고치게 한다.
  it('inbox는 VISIBLE_LEGACY_NAV_ITEMS 집합에서 빠진다(MOBILE_HUB_EXCLUDE_IDS 필터 — AC1 "동일 필터")', async () => {
    storage.set('sidebar_group_collapsed', JSON.stringify({ legacy: false }));
    await mount();
    const renderedIds = new Set(
      [...container.querySelectorAll('a[data-legacy-nav-id]')].map((a) => a.getAttribute('data-legacy-nav-id')),
    );
    expect(renderedIds.has('inbox')).toBe(false);
    expect(renderedIds.size).toBe(VISIBLE_LEGACY_NAV_ITEMS.length);
  });

  it('기억이 접힘(legacy:true)이어도 현재 경로가 「더보기」 안 항목이면 자동으로 펼쳐진다(활성 하이라이트, AC1)', async () => {
    storage.set('sidebar_group_collapsed', JSON.stringify({ legacy: true }));
    pathnameRef.current = '/activity';
    await mount();
    expect(moreToggle()!.getAttribute('aria-expanded')).toBe('true');
    const activeLink = [...container.querySelectorAll('a[data-legacy-nav-id="activity"]')][0] as HTMLAnchorElement;
    expect(activeLink).toBeDefined();
    expect(activeLink.hasAttribute('data-active')).toBe(true);
  });

  it('활성 항목이 없고 기억도 없으면(기본 접힘) 계속 접혀 있다', async () => {
    pathnameRef.current = '/dashboard';
    await mount();
    expect(moreToggle()!.getAttribute('aria-expanded')).toBe('false');
  });

  it('한자 0·부제 0 — 라벨은 정확히 "더보기" 텍스트뿐', async () => {
    await mount();
    const toggle = moreToggle()!;
    expect(toggle.textContent).toBe('더보기');
    expect(/[一-鿿]/.test(toggle.textContent ?? '')).toBe(false);
  });
});
