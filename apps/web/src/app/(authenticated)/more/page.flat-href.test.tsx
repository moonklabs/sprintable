// @vitest-environment jsdom
// story #4226 — 더보기의 flat(static) 링크는 useFlatHref(`?p=`)를 거치고, resource 항목(bare 폴백)은 거치지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 1024 }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => `${h}${h.includes('?') ? '&' : '?'}p=P` }));
const ctx = vi.hoisted(() => ({ value: { orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgSlug: 'ws-1' }], projectMemberships: [], currentProjectSlug: 'proj-1' as string | undefined } }));
vi.mock('@/app/dashboard/dashboard-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/dashboard/dashboard-shell')>();
  return { ...actual, useDashboardContext: () => ctx.value };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('MorePage — flat 링크 `?p=`(story #4226)', () => {
  async function hrefsOfMenu(): Promise<string[]> {
    const { default: MorePage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><MorePage /></TopBarProvider></NextIntlClientProvider>);
    });
    return [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
  }

  it('⭐static 항목(/org-briefing · /settings · /organization/…)은 `?p=`', async () => {
    const { default: MorePage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><MorePage /></TopBarProvider></NextIntlClientProvider>);
    });
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('/org-briefing?p=P');
    expect(hrefs).toContain('/settings?p=P');
    expect(hrefs.filter((h) => h.startsWith('/organization/')).every((h) => h.endsWith('p=P'))).toBe(true);
    expect(hrefs.some((h) => h === '/org-briefing' || h === '/settings')).toBe(false);
  });

  // story #4274(유나 실측 · PO) — resource 항목이 bare `/goals`면 proxy 307 동안 로딩 경계가 설 자리가 없어 «전체» 화면이 1.5초 그대로였다.
  it('⭐resource 항목(목표 · 문서 · 루프 …)은 프로젝트가 정해지면 `/{ws}/{proj}/{자원}` 직접 주소 — flat 리다이렉트 없음', async () => {
    const { NAV_GROUPS, LEGACY_NAV_ITEMS } = await import('@/lib/nav-config');
    const resourcePaths = [...NAV_GROUPS.flatMap((g) => g.items), ...LEGACY_NAV_ITEMS].filter((i) => i.kind === 'resource').map((i) => i.path);
    const hrefs = await hrefsOfMenu();
    const shown = resourcePaths.filter((p) => hrefs.includes(`/ws-1/proj-1/${p}`));
    expect(shown.length, '메뉴에 보이는 resource 항목이 직접 주소로').toBeGreaterThanOrEqual(3);
    expect(shown).toEqual(expect.arrayContaining(['goals', 'docs', 'loops']));
    for (const p of resourcePaths) expect(hrefs, `bare /${p}`).not.toContain(`/${p}`);
  });

  it('slug를 모르는 찰나엔 flat + `?p=`(bare 아님)', async () => {
    ctx.value = { ...ctx.value, currentProjectSlug: undefined };
    try {
      const hrefs = await hrefsOfMenu();
      expect(hrefs).toContain('/goals?p=P');
      expect(hrefs).not.toContain('/goals');
    } finally {
      ctx.value = { ...ctx.value, currentProjectSlug: 'proj-1' };
    }
  });
});

