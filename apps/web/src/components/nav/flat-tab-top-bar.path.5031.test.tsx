// @vitest-environment jsdom
//
// story 5031 (C1 step 5a · codex round 1) — the desktop bar's path with the REAL loading-fallback holders: every row of FLAT_ROUTE_TOP_BAR is mounted as its loading.tsx mounts it (`RouteTopBarFallback`) under the real TopBar, and the path must come out
// without the same name twice. The bug this pins: a title that is a COMPONENT (AgentsTopBarTitle · the settings fallback …) has no words an element scan can read, so the place's name was drawn again after it («조직 › 에이전트 › 에이전트», «조직 › 설정 › 설정»).
// A hand-made `<h1>` or `<span>` title cannot show that — these are the shipped title components.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => <a href={href} {...rest}>{children}</a> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORGS = [{ orgId: 'o1', orgName: '올리베이라 조직', orgSlug: 'acme' }];
const PROJECTS = [{ projectId: 'p1', projectName: '스프린터블' }];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

/** the address a route's loading.tsx is shown for: the list itself (`[ws]/[proj]/goals` → /acme/sprintable/goals) */
const addressOf = (route: string) => `/${route.replace('[ws]/[proj]', 'acme/sprintable')}`;

async function mountFallback(route: string) {
  pathnameRef.current = addressOf(route);
  vi.resetModules();
  const { TopBar } = await import('./top-bar');
  const { TopBarProvider } = await import('./top-bar-context');
  const { RouteTopBarFallback, FLAT_ROUTE_TOP_BAR } = await import('./flat-tab-top-bar');
  const { SidebarProvider } = await import('@/components/ui/sidebar');
  const { CommandPaletteProvider } = await import('@/components/command-palette/command-palette-context');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <CommandPaletteProvider><TopBarProvider><SidebarProvider>
          <TopBar orgId="o1" orgMemberships={ORGS} projectId="p1" projectMemberships={PROJECTS} />
          <RouteTopBarFallback route={route as keyof typeof FLAT_ROUTE_TOP_BAR} />
        </SidebarProvider></TopBarProvider></CommandPaletteProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return [...container.querySelectorAll('[data-testid="top-bar-path"] li')].map((li) => li.textContent!.trim()).filter(Boolean);
}

const routes = Object.keys((await import('./flat-tab-top-bar')).FLAT_ROUTE_TOP_BAR);

describe('the path under every loading fallback of FLAT_ROUTE_TOP_BAR (the shipped title components)', () => {
  it('the table is what the test walks (a new row is walked too)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(25);
  });

  for (const route of routes) {
    it(`⭐${route}: the path has no name twice in a row`, async () => {
      const items = await mountFallback(route);
      expect(items.length, `${route}: a path was drawn`).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < items.length; i++) expect(items[i], `${route}: «${items.join(' › ')}»`).not.toBe(items[i - 1]);
    });
  }

  it('⭐the two reported cases read once: 에이전트 first screen → «조직 › 에이전트» · the settings loading fallback → «조직 › 설정»', async () => {
    expect((await mountFallback('organization/workforce')).join(' › ')).toBe('올리베이라 조직 › 에이전트');
    expect((await mountFallback('settings')).join(' › ')).toBe('올리베이라 조직 › 설정');
  });

  it('every row carries the title\'s plain words (chats draws nothing: none)', async () => {
    const { FLAT_ROUTE_TOP_BAR } = await import('./flat-tab-top-bar');
    expect(Object.entries(FLAT_ROUTE_TOP_BAR).filter(([, e]) => typeof (e as { useText?: unknown }).useText !== 'function').map(([k]) => k)).toEqual([]);
  });
});
