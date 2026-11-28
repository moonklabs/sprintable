// @vitest-environment jsdom
//
// story 5031 (C1) — the settings «프로젝트» tab drew a FAILED read as an EMPTY list («이 조직에 프로젝트가 아직 없어요»): `refreshProjects` returned silently on `!res.ok`, a thrown fetch
// or a body with no `data` array, so `projects` stayed [] and the pane read as «no projects». The read now has three states (loading · ok · error): a failure says so, with a retry (ds Banner failed
// + ds Button — the shape of the small-area failures of story 5048), and only a truly empty answer draws the empty look. (boilerplate as page.org-context.4906.test.tsx)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.settings;
const C = koMessages.common;
let container: HTMLDivElement;
let root: Root;
let projectListUrls: string[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  projectListUrls = [];
  commitTexts.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {}); // the page logs the failed read (the logging is not what this file pins)
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => ({ data }) });

async function mountPage(query: string, projectsImpl: (url: string, call: number) => unknown, ctxOrgId = 'org-1') {
  useDashboardContextMock.mockReturnValue({ orgId: ctxOrgId, orgMemberships: [{ orgId: ctxOrgId, role: 'owner' }], currentMemberType: 'human', currentTeamMemberId: 'tm-1', projectId: null });
  vi.doMock('next/navigation', () => {
    const params = new URLSearchParams(query);
    return { useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => params, usePathname: () => '/settings' };
  });
  const fetchWithAuthMock = vi.fn(async (input: string) => {
    const url = String(input);
    if (url === '/api/me') return json({ role: 'owner', user_id: 'u1' });
    if (url === '/api/organizations') return json([{ id: ctxOrgId, name: '우리 조직', slug: 'our', role: 'owner' }]);
    return json(null, 404);
  });
  vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    if (url.startsWith('/api/projects') && method === 'GET') {
      projectListUrls.push(url);
      return projectsImpl(url, projectListUrls.length) as ReturnType<typeof json>;
    }
    return json(null, 404);
  }));
  await render();
}
// what the DOM said at the end of EVERY commit (a layout effect runs in the commit, before the passive effects that clear/refresh the list) — so the very first frame after an organization switch can be read
const commitTexts: string[] = [];
function CommitProbe() {
  useLayoutEffect(() => { commitTexts.push(document.body.textContent ?? ''); });
  return null;
}
async function render() {
  const { default: SettingsPage } = await import('./page');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /><CommitProbe /></NextIntlClientProvider>); });
  await flush();
}
async function switchOrgTo(orgId: string) {
  useDashboardContextMock.mockReturnValue({ orgId, orgMemberships: [{ orgId, role: 'owner' }], currentMemberType: 'human', currentTeamMemberId: 'tm-1', projectId: null });
  await render();
}

const text = () => document.body.textContent ?? '';
const hasText = (s: string) => text().includes(s);
const banner = () => document.querySelector('[data-slot="ds-banner"][data-tone="failed"]');
const retryButton = () => [...(banner()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === C.retry) as HTMLButtonElement | undefined;

describe('[SID:5031] settings › projects tab › a failed read is an error with a retry, not an empty list', () => {
  it('⭐(a) the list answers !ok → the failure sentence + a «다시 시도» are shown and the «no projects» text is NOT', async () => {
    await mountPage('tab=projects', () => json(null, 500));
    expect(hasText(T.projectListLoadFailed)).toBe(true);
    expect(banner()).not.toBeNull();
    expect(retryButton()).toBeDefined();
    expect(hasText(T.projectListEmpty)).toBe(false); // reverted → a failure looked like an empty list
  });

  it('⭐(b) the request throws → the same failure with a retry (not an empty list)', async () => {
    await mountPage('tab=projects', () => { throw new Error('network down'); });
    expect(hasText(T.projectListLoadFailed)).toBe(true);
    expect(retryButton()).toBeDefined();
    expect(hasText(T.projectListEmpty)).toBe(false);
  });

  it('⭐(b2) an answer with no `data` array is a failure too', async () => {
    await mountPage('tab=projects', () => ({ ok: true, status: 200, json: async () => ({ error: 'nope' }) }));
    expect(hasText(T.projectListLoadFailed)).toBe(true);
    expect(hasText(T.projectListEmpty)).toBe(false);
  });

  it('⭐(c) «다시 시도» asks again: a second read, the rows appear and the failure is gone; while it reads, neither the empty text nor the failure shows', async () => {
    let release: (v: unknown) => void = () => {};
    await mountPage('tab=projects', (_url, call) => (call === 1
      ? json(null, 500)
      : new Promise((resolve) => { release = resolve; })));
    expect(projectListUrls).toHaveLength(1);
    await act(async () => { retryButton()!.click(); });
    await flush();
    expect(projectListUrls).toHaveLength(2); // reverted (the press does nothing) → still one read
    expect(projectListUrls[1]).toBe('/api/projects?org_id=org-1');
    expect(hasText(T.projectListEmpty)).toBe(false); // reading again is not «no projects»
    expect(banner()).toBeNull();
    await act(async () => { release(json([{ id: 'p-a', name: '알파', description: null }])); });
    await flush();
    expect(hasText('알파')).toBe(true);
    expect(banner()).toBeNull();
    expect(hasText(T.projectListLoadFailed)).toBe(false);
  });

  it('(c2) a retry that fails again shows the failure again (not an empty list)', async () => {
    await mountPage('tab=projects', () => json(null, 503));
    await act(async () => { retryButton()!.click(); });
    await flush();
    expect(projectListUrls).toHaveLength(2);
    expect(hasText(T.projectListLoadFailed)).toBe(true);
    expect(hasText(T.projectListEmpty)).toBe(false);
  });

  it('⭐(d) an ok answer with no rows keeps today\'s empty look and no failure', async () => {
    await mountPage('tab=projects', () => json([]));
    expect(hasText(T.projectListEmpty)).toBe(true);
    expect(banner()).toBeNull();
    expect(hasText(T.projectListLoadFailed)).toBe(false);
  });

  it('⭐(e) a LATE failing answer for the old organization never writes after the organization switched', async () => {
    let failOld: (v: unknown) => void = () => {};
    await mountPage('tab=projects', (url) => (url.includes('org_id=org-1')
      ? new Promise((resolve) => { failOld = resolve; })
      : json([{ id: 'p-b', name: '둘째조직프로젝트', description: null }])));
    await switchOrgTo('org-2');
    expect(hasText('둘째조직프로젝트')).toBe(true);
    await act(async () => { failOld(json(null, 500)); });
    await flush();
    expect(hasText('둘째조직프로젝트')).toBe(true);
    expect(hasText(T.projectListLoadFailed)).toBe(false); // reverted (stale answer may write) → the old organization's failure lands on the new one
  });

  it('⭐(e2) switching organization resets an old organization\'s failure: the new organization reads again from «loading», not from the old error', async () => {
    let release: (v: unknown) => void = () => {};
    await mountPage('tab=projects', (url) => (url.includes('org_id=org-1')
      ? json(null, 500)
      : new Promise((resolve) => { release = resolve; })));
    expect(hasText(T.projectListLoadFailed)).toBe(true);
    await switchOrgTo('org-2');
    expect(hasText(T.projectListLoadFailed)).toBe(false); // reverted (no reset on the organization change) → the old error stays while org-2 reads
    expect(hasText(T.projectListEmpty)).toBe(false);
    await act(async () => { release(json([{ id: 'p-b', name: '둘째조직프로젝트', description: null }])); });
    await flush();
    expect(hasText('둘째조직프로젝트')).toBe(true);
    expect(banner()).toBeNull();
  });

  it('⭐(e3) a LATE throw for the old organization never writes either (the catch is guarded too)', async () => {
    let throwOld: (e: unknown) => void = () => {};
    await mountPage('tab=projects', (url) => (url.includes('org_id=org-1')
      ? new Promise((_resolve, reject) => { throwOld = reject; })
      : json([{ id: 'p-b', name: '둘째조직프로젝트', description: null }])));
    await switchOrgTo('org-2');
    await act(async () => { throwOld(new Error('network down')); });
    await flush();
    expect(hasText('둘째조직프로젝트')).toBe(true);
    expect(hasText(T.projectListLoadFailed)).toBe(false);
  });

  // codex 1: after an in-place organization switch the FIRST commit still carried the previous organization's list and read state (the effects that clear them run after it)
  it('⭐(f) the first frame after an organization switch holds none of the old organization\'s rows', async () => {
    await mountPage('tab=projects', (url) => (url.includes('org_id=org-1')
      ? json([{ id: 'p-a', name: '첫째조직프로젝트', description: null }])
      : new Promise(() => {}))); // the new organization's list is still on its way
    expect(hasText('첫째조직프로젝트')).toBe(true);
    const mark = commitTexts.length;
    await switchOrgTo('org-2');
    expect(commitTexts.length).toBeGreaterThan(mark);
    expect(commitTexts.slice(mark).some((t) => t.includes('첫째조직프로젝트'))).toBe(false); // reverted (drawn from the raw state) → the first commit still shows it
  });

  it('⭐(f2) the first frame after an organization switch holds neither the old organization\'s failure nor an «empty» look', async () => {
    await mountPage('tab=projects', (url) => (url.includes('org_id=org-1') ? json(null, 500) : new Promise(() => {})));
    expect(hasText(T.projectListLoadFailed)).toBe(true);
    const mark = commitTexts.length;
    await switchOrgTo('org-2');
    expect(commitTexts.length).toBeGreaterThan(mark);
    expect(commitTexts.slice(mark).some((t) => t.includes(T.projectListLoadFailed))).toBe(false);
    expect(commitTexts.slice(mark).some((t) => t.includes(T.projectListEmpty))).toBe(false);
  });
});
