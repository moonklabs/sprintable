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

const ctx = { orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgSlug: 'acme' }], currentProjectSlug: 'proj' as string | undefined };
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  ctx.currentProjectSlug = 'proj';
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

// story #4211(까디르 QA) — flat 경로 프로젝트 전환(`?p=B` push → /api/switch-project → router.refresh) 창에서 서버 slug는
// 아직 A라, 탭바·사이드바가 옛 프로젝트 직접 경로를 내지 않게 slug는 탭 effective 프로젝트와 같을 때만 싣는다.
describe('slugForEffectiveProject — 전환 창에서 옛 프로젝트 직접 경로 0(story #4211 까디르 QA)', () => {
  it('전환 창(effective B · 서버 slug A) → slug 없음 → 탭바·사이드바 href 둘 다 bare', async () => {
    const { slugForEffectiveProject, scopedResourceHref } = await import('@/lib/nav-v3-destinations');
    const slug = slugForEffectiveProject('proj-a', 'alpha', 'proj-b');
    expect(slug).toBeUndefined();
    expect(scopedResourceHref('flow', 'acme', slug)).toBe('/flow');
  });

  it('refresh 뒤(서버 slug B · effective B) → /{org}/{B}/…', async () => {
    const { slugForEffectiveProject, scopedResourceHref } = await import('@/lib/nav-v3-destinations');
    const slug = slugForEffectiveProject('proj-b', 'beta', 'proj-b');
    expect(slug).toBe('beta');
    expect(scopedResourceHref('flow', 'acme', slug)).toBe('/acme/beta/flow');
  });

  it('배선 핀 — 대시보드 셸이 이 값 하나를 컨텍스트(탭바)와 사이드바(ShellBody) 둘 다에 넘긴다', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', '..', 'app', 'dashboard', 'dashboard-shell.tsx'), 'utf8');
    expect(src).toMatch(/const scopedProjectSlug = slugForEffectiveProject\(projectId, currentProjectSlug, effectiveProjectId\);/);
    expect(src).toMatch(/currentProjectSlug: scopedProjectSlug,/);
    expect(src).toMatch(/currentProjectSlug=\{scopedProjectSlug\}/);
    // 원시 서버 slug를 그대로 넘기는 자리가 남아 있으면 안 된다(한쪽만 막으면 갈린다). 남는 1곳은 ShellBody가 **받은**
    // (이미 걸러진) prop을 AppSidebar로 그대로 넘기는 통로뿐이다.
    expect(src.match(/currentProjectSlug=\{currentProjectSlug\}/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/projectName: effectiveProjectName, currentProjectSlug, /);
  });
});
