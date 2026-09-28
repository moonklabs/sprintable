// @vitest-environment jsdom
//
// story #4211 — 모바일 탭바 «지금»(«일감») 탭이 bare `/flow`(세션 의존 flat 경로)를 가리켜, 누를 때마다 서버 리다이렉트
// 한 홉을 타고 4557 전 301을 캐시한 기기(웹·앱 WebView · prod는 아직 301)는 옛 프로젝트로 갔다. 이제 사이드바와 같은
// scopedResourceHref로 /{ws}/{proj}/{resource}를 직접 가리킨다.
// AC1 전수: 플래그 조합 전부 × 탭 전부의 실제 렌더 href 첫 세그먼트가 proxy의 flat 리다이렉트 표(MIGRATED·RENAMED·
// RETIRED)에 0 — 탭·목적지가 늘어도 이 표로 자동 검사된다(하드코딩 경로 대조가 아니다).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { MIGRATED_RESOURCES, RENAMED_RESOURCES, RETIRED_RESOURCES } from '@/lib/legacy-resource-tables';
import type { NavV3Flags } from '@/lib/nav-v3-destinations';

vi.mock('next/navigation', () => ({ usePathname: () => '/acme/proj/flow' }));

const ctx = { orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgSlug: 'acme' }], currentProjectSlug: 'proj' as string | undefined, projectPathUnresolved: false };
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  ctx.currentProjectSlug = 'proj';
  ctx.projectPathUnresolved = false;
});

async function hrefs(flags?: NavV3Flags): Promise<string[]> {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 390 });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const { MobileTabBar } = await import('./mobile-tab-bar');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <MobileTabBar chatUnreadTotal={0} navV3Flags={flags} />
      </NextIntlClientProvider>,
    );
  });
  return [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
}

const SESSION_DEPENDENT_FLAT = new Set([...Object.keys(MIGRATED_RESOURCES), ...Object.keys(RENAMED_RESOURCES), ...Object.keys(RETIRED_RESOURCES)]);
const firstSegment = (href: string) => href.split('?')[0]!.split('/').filter(Boolean)[0] ?? '';

const FLAG_COMBOS: NavV3Flags[] = [false, true].flatMap((a) => [false, true].flatMap((b) => [false, true].map((c) => (
  { todayV3Enabled: a, chatV3Enabled: b, connectRulesV3Enabled: c }
))));

describe('MobileTabBar — 탭 href에 세션 의존 flat 경로 0(story #4211 AC1)', () => {
  it.each(FLAG_COMBOS.map((f) => [JSON.stringify(f), f] as const))('플래그 %s — 전 탭', async (_n, flags) => {
    const list = await hrefs(flags);
    expect(list).toHaveLength(4);
    for (const href of list) expect(SESSION_DEPENDENT_FLAT.has(firstSegment(href))).toBe(false);
  });

  it('플래그 OFF — «지금» 탭은 /acme/proj/flow(현재 작업공간·프로젝트)', async () => {
    const list = await hrefs();
    expect(list).toContain('/acme/proj/flow');
    expect(list).not.toContain('/flow');
  });

  it('v3 ON — «일감» 탭은 /acme/proj/work-list', async () => {
    const list = await hrefs({ todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false });
    expect(list).toContain('/acme/proj/work-list');
  });

  it('slug를 아직 모르면(로그인 직후 찰나) bare 안전망으로 — 빈 링크·undefined 경로 0', async () => {
    ctx.currentProjectSlug = undefined;
    const list = await hrefs();
    expect(list).toContain('/flow');
    for (const href of list) expect(href).not.toContain('undefined');
  });
});

// story #4211(까디르 QA 2회) — slug는 «slug를 조회한 프로젝트(경로 ?? 세션)»와 탭 effective 프로젝트가 같을 때만.
describe('navProjectSlug — scoped 경로는 현재 URL 조각(story #4211 PO 3차 · 공유 레이아웃 클라이언트 이동)', () => {
  const stale = { pathProjectId: 'proj-b', sessionProjectId: 'proj-a', slug: 'beta', effectiveProjectId: 'proj-b' };

  it('⭐B → C 클라이언트 이동(서버 prop은 B에 머묾 · pathname만 C) → 탭바·사이드바 href 둘 다 /acme/charlie/…', async () => {
    const { navProjectSlug, scopedResourceHref } = await import('@/lib/nav-v3-destinations');
    const slug = navProjectSlug({ ...stale, pathname: '/acme/charlie/flow', currentOrgSlug: 'acme' });
    expect(scopedResourceHref('flow', 'acme', slug, (h) => h)).toBe('/acme/charlie/flow');
    expect(scopedResourceHref('docs', 'acme', slug, (h) => h)).toBe('/acme/charlie/docs');
  });

  it('flat 경로는 URL 조각을 안 쓰고 가드로(전환 창 → bare)', async () => {
    const { navProjectSlug } = await import('@/lib/nav-v3-destinations');
    expect(navProjectSlug({ pathname: '/flow', currentOrgSlug: 'acme', pathProjectId: undefined, sessionProjectId: 'proj-a', slug: 'alpha', effectiveProjectId: 'proj-b' })).toBeUndefined();
  });

  it('⭐org slug가 예약어(`gates`)인 조직이 flat `/gates/123`을 볼 때 → URL 조각을 안 쓰고 가드로(까디르 QA)', async () => {
    const { navProjectSlug, scopedResourceHref } = await import('@/lib/nav-v3-destinations');
    const slug = navProjectSlug({ ...stale, pathname: '/gates/123', currentOrgSlug: 'gates' });
    expect(slug).toBe('beta');
    expect(scopedResourceHref('flow', 'gates', slug, (h) => h)).not.toBe('/gates/123/flow');
  });

  it('다른 org 경로(첫 조각 ≠ 현재 org slug)는 URL 조각을 안 쓴다 — 전환기(withSwitchedSlugs)와 같은 판정', async () => {
    const { navProjectSlug } = await import('@/lib/nav-v3-destinations');
    expect(navProjectSlug({ ...stale, pathname: '/other/zeta/flow', currentOrgSlug: 'acme' })).toBe('beta');
    expect(navProjectSlug({ ...stale, pathname: '/acme/charlie/flow', currentOrgSlug: undefined })).toBe('beta');
  });
});

describe('slugForEffectiveProject — 딥링크·전환 창·refresh 뒤(story #4211 까디르 QA)', () => {
  it('⭐딥링크(세션 A · 경로 B · slug B · effective B) → /{ws}/B/… (세션 A로 보내지 않는다)', async () => {
    const { slugForEffectiveProject, scopedResourceHref } = await import('@/lib/nav-v3-destinations');
    const slug = slugForEffectiveProject({ pathProjectId: 'proj-b', sessionProjectId: 'proj-a', slug: 'beta', effectiveProjectId: 'proj-b' });
    expect(scopedResourceHref('flow', 'acme', slug, (h) => h)).toBe('/acme/beta/flow');
  });

  it('flat 전환 창(경로 없음 · 세션 A · slug A · effective B) → bare', async () => {
    const { slugForEffectiveProject, scopedResourceHref } = await import('@/lib/nav-v3-destinations');
    const slug = slugForEffectiveProject({ pathProjectId: undefined, sessionProjectId: 'proj-a', slug: 'alpha', effectiveProjectId: 'proj-b' });
    expect(slug).toBeUndefined();
    // story #4231 다음 조각 — slug 모름 폴백도 bare로 안 나간다: 필수 withProject가 현재 p를 싣는다.
    expect(scopedResourceHref('flow', 'acme', slug, (h) => `${h}?p=proj-b`)).toBe('/flow?p=proj-b');
  });

  it('refresh 뒤(세션 B · slug B · effective B) → /{ws}/B/…', async () => {
    const { slugForEffectiveProject, scopedResourceHref } = await import('@/lib/nav-v3-destinations');
    const slug = slugForEffectiveProject({ pathProjectId: undefined, sessionProjectId: 'proj-b', slug: 'beta', effectiveProjectId: 'proj-b' });
    expect(scopedResourceHref('flow', 'acme', slug, (h) => h)).toBe('/acme/beta/flow');
  });

  it('배선 핀 — 대시보드 셸이 현재 URL·경로 id·세션 id를 넘기고, 그 값 하나를 컨텍스트(탭바)와 사이드바(ShellBody) 둘 다에', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', '..', 'app', 'dashboard', 'dashboard-shell.tsx'), 'utf8');
    expect(src).toMatch(/const shellPathname = usePathname\(\);/);
    expect(src).toMatch(/navProjectSlug\(\{\s*pathname: shellPathname, currentOrgSlug,\s*pathProjectId, sessionProjectId: projectId, slug: currentProjectSlug, effectiveProjectId,\s*\}\)/);
    expect(src).toMatch(/currentProjectSlug: scopedProjectSlug,/);
    expect(src).toMatch(/currentProjectSlug=\{scopedProjectSlug\}/);
    // 원시 서버 slug를 그대로 넘기는 자리는 ShellBody가 **받은**(이미 걸러진) prop을 AppSidebar로 넘기는 통로 1곳뿐.
    expect(src.match(/currentProjectSlug=\{currentProjectSlug\}/g) ?? []).toHaveLength(1);
  });
});

describe('MobileTabBar — 못 푼 프로젝트 경로(story #4217 유나 QA)', () => {
  it('미해결이면 탭 href에 URL 프로젝트 조각 0 · 활성 탭 0', async () => {
    ctx.currentProjectSlug = undefined; // 셸이 미해결일 때 넘기는 값
    ctx.projectPathUnresolved = true;
    const list = await hrefs();
    expect(list.some((h) => h.includes('/proj/'))).toBe(false);
    expect(container.querySelectorAll('[aria-current="page"]').length).toBe(0);
  });
  it('대조군 — 풀린 경로(/acme/proj/flow)에선 «지금» 탭이 활성', async () => {
    await hrefs();
    expect(container.querySelectorAll('[aria-current="page"]').length).toBe(1);
  });
});
