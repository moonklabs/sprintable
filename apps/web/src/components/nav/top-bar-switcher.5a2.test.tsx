// @vitest-environment jsdom
//
// story 5031 (C1 step 5a-2 · PO 11-27) — the «조직» and «프로젝트» crumbs of the desktop top bar's path are buttons that open the SAME project-switcher menu (the hook `useUnifiedSwitcher` · the menu part `SwitcherMenuContent` the list column's switcher shares).
// Real TopBar · real host · real hook · real menu; only the network and the router are made up. The widths (1440 / 1280 / 1100) · real keyboard (Enter / Space / Esc / focus return) · the no-drag of the trigger and the open menu are measured in e2e/top-bar-zones.5031.layout.spec.ts
// (jsdom has no layout and no native Enter→click).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { nav, switchProject, switchOrg } = vi.hoisted(() => ({
  nav: { pathname: '/acme/sprintable/flow', push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), search: '' },
  switchProject: vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })),
  switchOrg: vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh, back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => <a href={href} {...rest}>{children}</a> }));
// the network: the projects of each organization (X-Org-Id) — two projects in this one, one in the other
vi.mock('@/lib/db/client', () => ({
  switchProject, switchOrg,
  fetchWithAuth: vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
    const org = init?.headers?.['X-Org-Id'];
    const data = org === 'o2' ? [{ id: 'q1', name: '다른 조직 프로젝트' }] : [{ id: 'p1', name: '스프린터블' }, { id: 'p2', name: '랜딩' }];
    return { ok: true, status: 200, json: async () => ({ data }) };
  }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORGS = [{ orgId: 'o1', orgName: '올리베이라 조직', orgSlug: 'acme', role: 'admin' }, { orgId: 'o2', orgName: '둘째 조직', orgSlug: 'second' }];
const PROJECTS = [{ projectId: 'p1', projectName: '스프린터블' }, { projectId: 'p2', projectName: '랜딩' }];
const bridge = Object.freeze({ inApp: true as const, device: { name: 'Mac' }, runtimes: [], pickFolder: vi.fn(async () => null), startHere: vi.fn(async () => ({ ok: true as const })), setProjectFolder: vi.fn(async () => ({ ok: true as const })) });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  nav.pathname = '/acme/sprintable/flow';
  nav.search = '';
  nav.push.mockClear(); nav.replace.mockClear(); nav.refresh.mockClear(); switchProject.mockClear(); switchOrg.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).startsWith('/api/projects/')
    ? new Response(JSON.stringify({ data: { slug: String(url).endsWith('p2') ? 'landing' : 'sprintable' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  delete (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop;
  vi.unstubAllGlobals();
  vi.resetModules();
});

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };

/** the bar (real) with the list column's switcher mounted beside it (a second instance) when `withColumn` */
async function mount(opts: { pathname?: string; title?: React.ReactNode; withColumn?: boolean; projectId?: string | undefined; strict?: boolean; noBar?: boolean }) {
  if (opts.pathname) nav.pathname = opts.pathname;
  const { TopBar } = await import('./top-bar');
  const { TopBarProvider } = await import('./top-bar-context');
  const { TopBarSlot } = await import('./top-bar-slot');
  const { SidebarProvider } = await import('@/components/ui/sidebar');
  const { UnifiedSwitcher } = await import('./unified-switcher');
  const tree = (projectId: string | undefined, noBar = opts.noBar) => {
    const body = (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider pathname={nav.pathname}><SidebarProvider>
          {noBar ? null : <TopBar orgId="o1" orgMemberships={ORGS} projectId={projectId} projectMemberships={PROJECTS} />}
          {opts.title !== undefined ? <TopBarSlot title={opts.title} /> : null}
          {opts.withColumn ? <UnifiedSwitcher orgs={ORGS} currentOrgId="o1" projects={PROJECTS} currentProjectId={projectId} /> : null}
        </SidebarProvider></TopBarProvider>
      </NextIntlClientProvider>
    );
    return opts.strict ? <React.StrictMode>{body}</React.StrictMode> : body;
  };
  const pid = 'projectId' in opts ? opts.projectId : 'p1';
  await act(async () => { root.render(tree(pid)); });
  await settle();
  return {
    rerender: async (projectId: string | undefined) => { await act(async () => { root.render(tree(projectId)); }); await settle(); },
    /** the bar is gone (a phone's settings has none) while the list column's switcher stays */
    withoutBar: async () => { await act(async () => { root.render(tree(pid, true)); }); await settle(); },
  };
}
const trigger = (kind: 'org' | 'project') => container.querySelector(`[data-testid="top-bar-switcher-${kind}"]`) as HTMLButtonElement | null;
const menu = () => document.body.querySelector('[role="menu"]') as HTMLElement | null;
const itemTexts = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((e) => e.textContent!.trim());
const newProjectDialogs = () => [...document.body.querySelectorAll('[role="dialog"]')].filter((d) => d.textContent?.includes(koMessages.nav.switcherNewProjectDialogTitle));
const crumbTexts = () => [...container.querySelectorAll('[data-testid="top-bar-path"] li[data-crumb]')].map((li) => li.textContent!.trim());

describe('TopBar 5a-2 — the «조직» · «프로젝트» crumbs are triggers of the project switcher\'s menu', () => {
  it('⭐1 the project crumb is a menu button (aria-haspopup=menu, a name that starts with its words and says what it does); pressing it opens the menu with the current organization\'s projects and a check on the current one', async () => {
    await mount({ title: <span>흐름</span> });
    const t = trigger('project')!;
    expect(t.tagName).toBe('BUTTON');
    expect(t.getAttribute('aria-haspopup')).toBe('menu');
    expect(t.getAttribute('aria-label')).toBe(`스프린터블, ${koMessages.nav.topBarSwitcher}`);
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(menu()).toBeNull();
    await act(async () => { t.click(); });
    await settle();
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(menu(), 'the menu role opens').not.toBeNull();
    expect(itemTexts()).toEqual(expect.arrayContaining(['스프린터블', '랜딩', koMessages.nav.switcherNewProject, koMessages.nav.switcherNewOrganization]));
    // the check mark sits on the current project's line only
    const lines = [...menu()!.querySelectorAll('[role="menuitem"]')];
    expect(lines.find((l) => l.textContent!.includes('스프린터블'))!.querySelector('svg'), 'the check').not.toBeNull();
    expect(lines.find((l) => l.textContent!.trim() === '랜딩')!.querySelector('svg')).toBeNull();
  });

  it('⭐2 choosing another project calls the switcher\'s switchProject with that project id and goes to its address; the path\'s project crumb then reads the new project', async () => {
    const m = await mount({ title: <span>흐름</span> });
    await act(async () => { trigger('project')!.click(); });
    await settle();
    const line = [...menu()!.querySelectorAll('[role="menuitem"]')].find((l) => l.textContent!.trim() === '랜딩') as HTMLElement;
    await act(async () => { line.click(); });
    await settle();
    expect(switchProject).toHaveBeenCalledWith('p2');
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(String(nav.push.mock.calls[0]![0])).toContain('/acme/landing/flow?p=p2'); // the slug path of the new project, same screen
    expect(nav.refresh).toHaveBeenCalled(); // the lists / queries are re-read
    // the shell then hands the bar the new project: the crumb says it
    await m.rerender('p2');
    expect(crumbTexts()).toEqual(['올리베이라 조직', '랜딩']);
  });

  it('⭐3 the organization crumb opens the SAME menu (one state): the same lines, the other organization with its project', async () => {
    await mount({ title: <span>흐름</span> });
    await act(async () => { trigger('project')!.click(); });
    await settle();
    const fromProject = itemTexts();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    await act(async () => { trigger('org')!.click(); });
    await settle();
    expect(menu()).not.toBeNull();
    expect(itemTexts()).toEqual(fromProject);
    expect(itemTexts()).toContain('다른 조직 프로젝트');
    // only one of the two menus is ever open
    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);
  });

  it('⭐7 a screen with NO project (홈): the organization crumb is the trigger and opens the menu (organization → project lines)', async () => {
    await mount({ pathname: '/org-briefing', title: <span>오늘</span>, projectId: undefined });
    expect(trigger('project')).toBeNull();
    expect(crumbTexts()).toEqual(['올리베이라 조직', '홈']);
    await act(async () => { trigger('org')!.click(); });
    await settle();
    expect(menu()).not.toBeNull();
    expect(itemTexts()).toEqual(expect.arrayContaining(['스프린터블', '랜딩', '다른 조직 프로젝트']));
  });

  it('Esc closes the menu (and a menu opened under the other crumb never leaves two open)', async () => {
    await mount({ title: <span>흐름</span> });
    await act(async () => { trigger('org')!.click(); });
    await settle();
    expect(menu()).not.toBeNull();
    await act(async () => { menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    expect(menu()).toBeNull();
    expect(trigger('org')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('⭐6 below lg the crumbs are not drawn (they sit in `hidden lg:flex` items) and the phone\'s chip is still the door — the bar\'s chip slot is untouched', async () => {
    await mount({ title: <span>흐름</span> });
    for (const li of container.querySelectorAll('[data-testid="top-bar-path"] li[data-crumb]')) expect(li.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:flex']));
    // the phone's door is the same part as before, still drawn from the bar's chip slot (its own tests are context-switcher-chip.test.tsx — untouched by 5a-2)
    const src = readFileSync(path.join(__dirname, 'top-bar.tsx'), 'utf8');
    expect(src).toMatch(/\{showContextChip && \(\s*<ContextSwitcherChip/);
  });
});

describe('TopBar 5a-2 — the «새 프로젝트» door of the desktop app opens ONE dialog however many switchers are mounted', () => {
  it('⭐3b the sidebar line\'s event with the bar\'s switcher AND the list column\'s switcher mounted: exactly one «새 프로젝트» dialog (the bar\'s)', async () => {
    (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = bridge;
    const { OPEN_NEW_PROJECT_EVENT } = await import('./new-project-entry');
    const { __newProjectOwnerCount } = await import('./new-project-owner');
    await mount({ title: <span>흐름</span>, withColumn: true });
    expect(__newProjectOwnerCount(), 'two instances are mounted').toBe(2);
    expect(newProjectDialogs()).toHaveLength(0);
    await act(async () => { window.dispatchEvent(new Event(OPEN_NEW_PROJECT_EVENT)); });
    await settle();
    expect(newProjectDialogs()).toHaveLength(1);
  });

  it('⭐3c the app menu\'s ⌘N flag with both mounted: one dialog, and the flag is taken off the address', async () => {
    (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = bridge;
    const { NEW_PROJECT_PARAM } = await import('./new-project-entry');
    window.history.replaceState(null, '', `/dashboard?x=1&${NEW_PROJECT_PARAM}=1`);
    await mount({ title: <span>흐름</span>, withColumn: true });
    await settle();
    expect(newProjectDialogs()).toHaveLength(1);
    expect(window.location.search).toBe('?x=1');
    window.history.replaceState(null, '', '/');
  });

  it('a browser (no bridge): the event opens nothing', async () => {
    const { OPEN_NEW_PROJECT_EVENT } = await import('./new-project-entry');
    await mount({ title: <span>흐름</span>, withColumn: true });
    await act(async () => { window.dispatchEvent(new Event(OPEN_NEW_PROJECT_EVENT)); });
    await settle();
    expect(newProjectDialogs()).toHaveLength(0);
  });

  it('the «새 프로젝트» line of the menu itself opens the bar\'s dialog (one dialog, from either crumb)', async () => {
    await mount({ title: <span>흐름</span> });
    await act(async () => { trigger('org')!.click(); });
    await settle();
    const line = [...menu()!.querySelectorAll('[role="menuitem"]')].find((l) => l.textContent!.trim() === koMessages.nav.switcherNewProject) as HTMLElement;
    await act(async () => { line.click(); });
    await settle();
    expect(newProjectDialogs()).toHaveLength(1);
  });
});

// story 5031 (5a-2 · codex): the owner registry at the React level — StrictMode's double effect, the bar going away, the ⌘N flag that comes late
describe('TopBar 5a-2 — the new-project door at the React level', () => {
  it('⭐StrictMode (every effect runs twice): still two registered instances (not four) and exactly one dialog', async () => {
    (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = bridge;
    const { OPEN_NEW_PROJECT_EVENT } = await import('./new-project-entry');
    const { __newProjectOwnerCount } = await import('./new-project-owner');
    await mount({ title: <span>흐름</span>, withColumn: true, strict: true });
    expect(__newProjectOwnerCount()).toBe(2);
    await act(async () => { window.dispatchEvent(new Event(OPEN_NEW_PROJECT_EVENT)); });
    await settle();
    expect(newProjectDialogs()).toHaveLength(1);
  });

  it('⭐the bar goes away (a phone\'s settings draws none): the list column\'s switcher takes the door over — one dialog, and the owner count drops to one', async () => {
    (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = bridge;
    const { OPEN_NEW_PROJECT_EVENT } = await import('./new-project-entry');
    const { __newProjectOwnerCount } = await import('./new-project-owner');
    const m = await mount({ title: <span>흐름</span>, withColumn: true });
    expect(__newProjectOwnerCount()).toBe(2);
    await m.withoutBar();
    expect(__newProjectOwnerCount()).toBe(1);
    await act(async () => { window.dispatchEvent(new Event(OPEN_NEW_PROJECT_EVENT)); });
    await settle();
    expect(newProjectDialogs()).toHaveLength(1);
  });

  it('LIMIT (intended): the ⌘N flag is read when a switcher registers; a flag that appears later on a page that is already mounted opens nothing (the window event is the door for an open page — see new-project-owner.ts)', async () => {
    (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = bridge;
    const { NEW_PROJECT_PARAM } = await import('./new-project-entry');
    await mount({ title: <span>흐름</span>, withColumn: true });
    window.history.replaceState(null, '', `/dashboard?${NEW_PROJECT_PARAM}=1`);
    await settle();
    expect(newProjectDialogs()).toHaveLength(0);
    expect(window.location.search, 'and the flag is left where it is').toBe(`?${NEW_PROJECT_PARAM}=1`);
    window.history.replaceState(null, '', '/');
  });
});
