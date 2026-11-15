// @vitest-environment jsdom
//
// story 4906 (PO 11-12) — a fresh account has an organization but NO project. The settings screen used to take its organization id ONLY from
// /api/current-project, so that account had none: «프로젝트 만들기» said «조직 컨텍스트를 찾지 못했어요» (and so the chat list's «프로젝트 만들기» path never came back),
// and the organization panes never mounted. The screen now reads ONE id: the dashboard's organization context first, the current project's organization as the fallback.
// (boilerplate as page.project-return.4906.test.tsx)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.settings;
let container: HTMLDivElement;
let root: Root;
const assignMock = vi.fn();
type Call = { url: string; method: string; body: unknown };
let projectPosts: Call[];
let projectListUrls: string[];
let orgListCalls: number;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  projectPosts = [];
  projectListUrls = [];
  orgListCalls = 0;
  assignMock.mockClear();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign: assignMock } });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.resetModules();
});

const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => ({ data }) });

/** `hasProject: false` = a fresh account: /api/current-project has nothing to say. `ctxOrgId: null` = the dashboard context has no organization (the old source is the only one). */
async function mountPage(query: string, opts: { hasProject: boolean; ctxOrgId: string | null; orgListImpl?: () => unknown; projectsImpl?: (url: string) => unknown }) {
  useDashboardContextMock.mockReturnValue({
    orgId: opts.ctxOrgId, orgMemberships: opts.ctxOrgId ? [{ orgId: opts.ctxOrgId, role: 'owner' }] : [], currentMemberType: 'human', currentTeamMemberId: 'tm-1', projectId: opts.hasProject ? 'p1' : null,
  });
  vi.doMock('next/navigation', () => {
    const params = new URLSearchParams(query);
    return { useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => params, usePathname: () => '/settings' };
  });
  const fetchWithAuthMock = vi.fn(async (input: string) => {
    const url = String(input);
    if (url === '/api/me') return json({ role: 'owner', user_id: 'u1' });
    if (url === '/api/current-project') return opts.hasProject ? json({ project_id: 'p1', org_id: 'org-1' }) : json(null, 404);
    if (url === '/api/organizations') { orgListCalls += 1; return (opts.orgListImpl?.() ?? json([{ id: 'org-1', name: '우리 조직', slug: 'our', role: 'owner' }])) as ReturnType<typeof json>; }
    return json(null, 404);
  });
  vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    if (url.startsWith('/api/projects') && method === 'GET') { projectListUrls.push(url); return (opts.projectsImpl?.(url) ?? json([])) as ReturnType<typeof json>; }
    if (url === '/api/projects' && method === 'POST') {
      projectPosts.push({ url, method, body: JSON.parse(String(init?.body)) });
      return json({ id: 'p3', name: '감마' }, 201);
    }
    return json(null, 404);
  }));
  const { default: SettingsPage } = await import('./page');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /></NextIntlClientProvider>); });
  await flush();
}

const buttons = () => [...document.querySelectorAll('button')] as HTMLButtonElement[];
const btn = (text: string) => buttons().filter((b) => b.textContent?.trim() === text)[0]!;
const labelOf = (input: HTMLInputElement) => (input.labels?.[0]?.textContent ?? '').trim();
const boxes = (name: string) => [...document.querySelectorAll('input')].filter((i) => i.placeholder === name || labelOf(i) === name) as HTMLInputElement[];
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function createProjectNamed(name: string) {
  await type(boxes(T.projectNamePlaceholder).slice(-1)[0]!, name);
  await act(async () => { btn(T.createProjectAction).click(); });
  await flush();
}
const text = () => document.body.textContent ?? '';

describe('[SID:4906] settings › one organization id: a fresh account (organization, no project) can make its first project', () => {
  it('⭐no project + the dashboard knows the organization: «만들기» sends org_id and, from the chat list (return=chats), goes back to /chats on the new project', async () => {
    await mountPage('tab=projects&return=chats', { hasProject: false, ctxOrgId: 'org-1' });
    await createProjectNamed('감마');
    expect(text()).not.toContain(T.projectCreateOrgMissing); // reverted → «조직 컨텍스트를 찾지 못했어요»
    expect(projectPosts).toHaveLength(1);
    expect((projectPosts[0]!.body as { org_id?: string }).org_id).toBe('org-1');
    expect(assignMock).toHaveBeenCalledWith('/chats?p=p3');
  });

  it('⭐the project list is read for THAT organization (not the unscoped list) and the organization details load without a project', async () => {
    await mountPage('tab=projects', { hasProject: false, ctxOrgId: 'org-1' });
    expect(projectListUrls.some((u) => u === '/api/projects?org_id=org-1')).toBe(true);
    expect(orgListCalls).toBeGreaterThan(0); // reverted → loaded only inside the «has a current project» branch
  });

  it('the old source still works: no organization in the dashboard context but a current project → its organization is used', async () => {
    await mountPage('tab=projects', { hasProject: true, ctxOrgId: null });
    await createProjectNamed('감마');
    expect(text()).not.toContain(T.projectCreateOrgMissing);
    expect((projectPosts[0]!.body as { org_id?: string }).org_id).toBe('org-1');
  });

  it('with NO organization anywhere the honest message stays (nothing is sent)', async () => {
    await mountPage('tab=projects', { hasProject: false, ctxOrgId: null });
    await createProjectNamed('감마');
    expect(projectPosts).toHaveLength(0);
    expect(text()).toContain(T.projectCreateOrgMissing);
  });

  async function switchOrgTo(orgId: string) {
    useDashboardContextMock.mockReturnValue({ orgId, orgMemberships: [{ orgId, role: 'owner' }], currentMemberType: 'human', currentTeamMemberId: 'tm-1', projectId: null });
    const { default: SettingsPage } = await import('./page');
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /></NextIntlClientProvider>); });
    await flush();
  }
  const inputValues = () => [...document.querySelectorAll('input')].map((i) => i.value);

  it('⭐codex: a LATE answer for the old organization (its body still being read) never overwrites the details of the organization the screen switched to', async () => {
    // (the org delete / rename go by orgInfo.id — a stale org-1 there would aim them at the wrong organization)
    let releaseBody: (v: unknown) => void = () => {};
    let call = 0;
    await mountPage('tab=organization', {
      hasProject: false, ctxOrgId: 'org-1',
      orgListImpl: () => {
        call += 1;
        if (call === 1) return { ok: true, status: 200, json: () => new Promise((resolve) => { releaseBody = resolve; }) };
        return json([{ id: 'org-2', name: '둘째 조직', slug: 'two', role: 'owner' }]);
      },
    });
    await switchOrgTo('org-2');
    expect(inputValues()).toContain('둘째 조직');
    await act(async () => { releaseBody({ data: [{ id: 'org-1', name: '첫째 조직', slug: 'one', role: 'owner' }] }); });
    await flush();
    expect(inputValues()).toContain('둘째 조직');
    expect(inputValues()).not.toContain('첫째 조직');
  });

  it('⭐codex: when the organization changes and the new details do not load, the OLD organization\'s details are gone (not left to be edited or deleted)', async () => {
    let call = 0;
    await mountPage('tab=organization', {
      hasProject: false, ctxOrgId: 'org-1',
      orgListImpl: () => {
        call += 1;
        return call === 1 ? json([{ id: 'org-1', name: '첫째 조직', slug: 'one', role: 'owner' }]) : json(null, 500);
      },
    });
    expect(inputValues()).toContain('첫째 조직');
    await switchOrgTo('org-2');
    expect(inputValues()).not.toContain('첫째 조직'); // the name box (edit · delete go by it) is gone until the new details load
    expect(document.body.textContent).not.toContain('첫째 조직');
  });

  const hasText = (s: string) => (document.body.textContent ?? '').includes(s);

  it('⭐codex round 2: switching organization clears the OLD organization\'s project rows at once (their edit · delete send only a project id)', async () => {
    await mountPage('tab=projects', {
      hasProject: false, ctxOrgId: 'org-1',
      projectsImpl: (url) => (url.includes('org_id=org-1')
        ? json([{ id: 'p-a', name: '첫째조직프로젝트', description: null }])
        : new Promise(() => {})), // the new organization's list is still loading
    });
    expect(hasText('첫째조직프로젝트')).toBe(true);
    await switchOrgTo('org-2');
    expect(hasText('첫째조직프로젝트')).toBe(false); // reverted → the old rows stay and stay actionable
  });

  it('⭐codex round 2: a LATE project list for the old organization never replaces the new organization\'s list', async () => {
    let releaseOld: (v: unknown) => void = () => {};
    await mountPage('tab=projects', {
      hasProject: false, ctxOrgId: 'org-1',
      projectsImpl: (url) => (url.includes('org_id=org-1')
        ? new Promise((resolve) => { releaseOld = resolve; })
        : json([{ id: 'p-b', name: '둘째조직프로젝트', description: null }])),
    });
    await switchOrgTo('org-2');
    expect(hasText('둘째조직프로젝트')).toBe(true);
    await act(async () => { releaseOld(json([{ id: 'p-a', name: '첫째조직프로젝트', description: null }])); });
    await flush();
    expect(hasText('둘째조직프로젝트')).toBe(true);
    expect(hasText('첫째조직프로젝트')).toBe(false);
  });
});
