// @vitest-environment jsdom
//
// story #4226 — 모바일 탭바가 지금 보는 바로 그 페이지를 프리패치하지 않는다(로컬 prod 빌드 실측: 착지 ≈1.4초 뒤 현재 페이지
// RSC 데이터 프리패치 1건). «활성 탭»이 아니라 «href 경로 = 현재 pathname»으로만 끈다 — 대화 상세(/chats/{id})에서 채팅 탭의
// /chats 프리패치는 목록 복귀를 빠르게 하므로 유지.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const nav = { pathname: '/acme/proj/flow' };
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
  it('⭐/acme/proj/flow에서 일감 탭(/acme/proj/flow)은 prefetch=false · 나머지 탭은 기본값(undefined)', async () => {
    const byHref = await renderAt('/acme/proj/flow');
    expect(byHref.get('/acme/proj/flow')).toBe(false);
    const others = [...byHref.entries()].filter(([href]) => href !== '/acme/proj/flow');
    expect(others.length).toBeGreaterThanOrEqual(3);
    for (const [href, prefetch] of others) expect(prefetch, href).toBeUndefined();
  });

  it('활성이지만 다른 페이지 — 대화 상세(/chats/c-1)에서 채팅 탭(활성 · href /chats)의 프리패치는 기본값 그대로(목록 복귀가 빠르게)', async () => {
    const byHref = await renderAt('/chats/c-1');
    expect(byHref.get('/chats')).toBeUndefined();
  });

  it('쿼리 달린 탭(/inbox?tab=gates)도 경로로 대조 — /inbox에선 결재 탭 prefetch=false', async () => {
    const byHref = await renderAt('/inbox');
    const inbox = [...byHref.entries()].find(([href]) => href.startsWith('/inbox'));
    expect(inbox?.[1]).toBe(false);
  });
});

describe('MobileTabBar — flat 탭 링크는 처음부터 `?p={현재 프로젝트}`(story #4226)', () => {
  it('⭐flat 탭(결재·채팅·더보기)은 `?p=proj-1`을 싣고 · scoped 탭(/acme/proj/flow)은 경로가 프로젝트라 안 싣는다', async () => {
    ctx.projectId = 'proj-1';
    const hrefs = [...(await renderAt('/acme/proj/flow')).keys()];
    const scoped = hrefs.filter((h) => h.startsWith('/acme/proj/'));
    const flat = hrefs.filter((h) => !h.startsWith('/acme/proj/'));
    expect(scoped).toEqual(['/acme/proj/flow']);
    expect(flat.length).toBeGreaterThanOrEqual(3);
    for (const h of flat) expect(new URLSearchParams(h.split('?')[1] ?? '').get('p'), h).toBe('proj-1');
    expect(hrefs).toContain('/inbox?tab=gates&p=proj-1'); // 기존 쿼리 보존
  });

  it('프로젝트를 아직 모르면 붙이지 않는다', async () => {
    const hrefs = [...(await renderAt('/acme/proj/flow')).keys()];
    for (const h of hrefs) expect(h).not.toContain('p=');
  });

  it('현재 페이지 판정은 `?p=`가 붙어도 경로로 — /inbox에서 결재 탭 prefetch=false 그대로', async () => {
    ctx.projectId = 'proj-1';
    const byHref = await renderAt('/inbox');
    expect(byHref.get('/inbox?tab=gates&p=proj-1')).toBe(false);
  });
});
