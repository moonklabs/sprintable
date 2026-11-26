// @vitest-environment jsdom
//
// story #4226 — 모바일 탭바가 지금 보는 바로 그 페이지를 프리패치하지 않는다(로컬 prod 빌드 실측: 착지 ≈1.4초 뒤 현재 페이지
// RSC 데이터 프리패치 1건). «활성 탭»이 아니라 «href 경로 = 현재 pathname»으로만 끈다 — 대화 상세(/chats/{id})에서 채팅 탭의
// /chats 프리패치는 목록 복귀를 빠르게 하므로 유지.
// story 5031 (C1 4단계) — 탭은 홈 · 채팅 · 에이전트 · 설정(전부 flat 링크)이라 옛 «일감 scoped 탭(/acme/proj/flow)»은 없다: «현재 페이지 탭» 사례는 에이전트(/organization/workforce) · 설정(/settings)으로.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const nav = { pathname: '/organization/workforce' };
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const linkProps: { href: string; prefetch: unknown }[] = [];
vi.mock('next/link', () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean | null; children?: ReactNode }) => {
    linkProps.push({ href, prefetch });
    return <a href={href} {...rest}>{children}</a>;
  },
}));

const ctx = { orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgSlug: 'acme' }], currentProjectSlug: 'proj' as string | undefined, projectPathUnresolved: false, projectId: undefined as string | undefined };
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  linkProps.length = 0;
  ctx.projectId = undefined;
});

async function renderAt(pathname: string): Promise<Map<string, unknown>> {
  nav.pathname = pathname;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const { MobileTabBar } = await import('./mobile-tab-bar');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <MobileTabBar chatUnreadTotal={0} />
      </NextIntlClientProvider>,
    );
  });
  const last = new Map<string, unknown>();
  for (const p of linkProps) last.set(p.href, p.prefetch);
  return last;
}

describe('MobileTabBar — 현재 페이지 탭은 프리패치하지 않는다(story #4226)', () => {
  it('⭐/organization/workforce에서 에이전트 탭은 prefetch=false · 나머지 세 탭은 기본값(undefined)', async () => {
    const byHref = await renderAt('/organization/workforce');
    expect(byHref.get('/organization/workforce')).toBe(false);
    const others = [...byHref.entries()].filter(([href]) => href !== '/organization/workforce');
    expect(others.map(([href]) => href)).toEqual(['/org-briefing', '/chats', '/settings']);
    for (const [href, prefetch] of others) expect(prefetch, href).toBeUndefined();
  });

  it('설정 탭(/settings)도 현재 페이지면 prefetch=false — 하위 화면(/settings/integrations)에선 활성이어도 기본값(설정 첫 화면으로 가는 길이 빠르게)', async () => {
    const onSettings = await renderAt('/settings');
    expect(onSettings.get('/settings')).toBe(false);
    const onSub = await renderAt('/settings/integrations');
    expect(onSub.get('/settings')).toBeUndefined();
  });

  it('활성이지만 다른 페이지 — 대화 상세(/chats/c-1)에서 채팅 탭(활성 · href /chats)의 프리패치는 기본값 그대로(목록 복귀가 빠르게)', async () => {
    const byHref = await renderAt('/chats/c-1');
    expect(byHref.get('/chats')).toBeUndefined();
  });

  it('홈 탭(/org-briefing)도 현재 페이지면 prefetch=false — 결재 화면(/inbox)은 «홈»이 품지만 탭 링크 자체는 /org-briefing라 거기선 기본값(홈 화면으로 가는 길이 빠르게)', async () => {
    const onHome = await renderAt('/org-briefing');
    expect(onHome.get('/org-briefing')).toBe(false);
    const onInbox = await renderAt('/inbox');
    expect(onInbox.get('/org-briefing')).toBeUndefined();
  });
});

describe('MobileTabBar — flat 탭 링크는 처음부터 `?p={현재 프로젝트}`(story #4226)', () => {
  it('⭐탭 넷 전부 flat — 전부 `?p=proj-1`을 싣고 · 경로 자체가 프로젝트인 scoped 탭(/acme/proj/…)은 없다', async () => {
    ctx.projectId = 'proj-1';
    const hrefs = [...(await renderAt('/acme/proj/flow')).keys()];
    expect(hrefs.filter((h) => h.startsWith('/acme/proj/'))).toEqual([]);
    expect(hrefs).toEqual([
      '/org-briefing?p=proj-1',
      '/chats?p=proj-1',
      '/organization/workforce?p=proj-1',
      '/settings?p=proj-1',
    ]);
  });

  it('⭐전환 대기 중엔 목표 프로젝트를 싣는다(커밋 전 컨텍스트는 아직 옛 프로젝트 — 까디르 QA [P2])', async () => {
    const { setPendingProjectTarget } = await import('@/lib/pending-project-switch');
    ctx.projectId = 'proj-A';
    setPendingProjectTarget('proj-B');
    try {
      const hrefs = [...(await renderAt('/org-briefing')).keys()];
      expect(hrefs).toContain('/org-briefing?p=proj-B');
      expect(hrefs.some((h) => h.includes('p=proj-A'))).toBe(false);
    } finally {
      setPendingProjectTarget(null);
    }
  });

  it('프로젝트를 아직 모르면 붙이지 않는다', async () => {
    const hrefs = [...(await renderAt('/acme/proj/flow')).keys()];
    for (const h of hrefs) expect(h).not.toContain('p=');
  });

  it('현재 페이지 판정은 `?p=`가 붙어도 경로로 — /org-briefing에서 홈 탭 prefetch=false 그대로', async () => {
    ctx.projectId = 'proj-1';
    const byHref = await renderAt('/org-briefing');
    expect(byHref.get('/org-briefing?p=proj-1')).toBe(false);
  });
});
