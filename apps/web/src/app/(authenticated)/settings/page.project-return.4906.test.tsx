// @vitest-environment jsdom
//
// story 4906 (PO 11-12) — a project made from the chat list's empty state returns the person to /chats; made from settings itself the person stays. (boilerplate as page.requests.4891.test.tsx)
// story 4891 (UI-8 · settings frame + four tabs) — «the requests did not change». The project pane and the two confirmations (project delete · organization delete) moved onto ds parts; what a press SENDS must be what it sent before — the project create /
// update / delete bodies and the organization delete body (with the «go on without the impact» acknowledgement). The whole `SettingsPage` is mounted (the page still owns the state and every handler), and the controls are found the way a person finds them —
// by their words (a placeholder, or a visible name) and by the button's text — so the same file is green on the old screen and the new one (it was run on both: develop and this change).
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
const pushMock = vi.fn();
type Call = { url: string; method: string; body: unknown };
let projectCalls: Call[];
let orgCalls: Call[];
let impactOk: boolean;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  projectCalls = [];
  orgCalls = [];
  pushMock.mockClear();
  impactOk = true;
  useDashboardContextMock.mockReturnValue({
    orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', role: 'owner' }], currentMemberType: 'human', currentTeamMemberId: 'tm-1', projectId: 'p1',
  });
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

async function mountPage(query: string) {
  vi.doMock('next/navigation', () => {
    const params = new URLSearchParams(query); // a stable reference, like Next's
    return { useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: pushMock, prefetch: vi.fn() }), useSearchParams: () => params, usePathname: () => '/settings' };
  });
  const fetchWithAuthMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    if (url === '/api/me') return json({ role: 'owner', user_id: 'u1' });
    if (url === '/api/current-project') return json({ project_id: 'p1', org_id: 'org-1' });
    if (url === '/api/organizations') return json([{ id: 'org-1', name: '우리 조직', slug: 'our', role: 'owner' }]);
    if (url === '/api/organizations/org-1/impact') return impactOk ? json({ project_count: 2, member_count: 3, has_active_subscription: false }) : json(null, 500);
    if (url === '/api/organizations/org-1' && method === 'DELETE') {
      orgCalls.push({ url, method, body: JSON.parse(String(init?.body ?? 'null')) });
      return json(null, 500); // not ok: the page toasts and closes (an ok answer would navigate the whole window)
    }
    return json(null, 404);
  });
  vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    if (url.startsWith('/api/projects') && method === 'GET') return json([{ id: 'p1', name: '알파', description: '첫째' }, { id: 'p2', name: '베타', description: null }]);
    if (url === '/api/projects' && method === 'POST') {
      projectCalls.push({ url, method, body: JSON.parse(String(init?.body)) });
      return json({ id: 'p3', name: '감마' }, 201);
    }
    if (url.startsWith('/api/projects/') && (method === 'PATCH' || method === 'DELETE')) {
      projectCalls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return method === 'PATCH' ? json({ id: 'p2', name: '베타 둘', description: '설명' }) : json({}, 200);
    }
    return json(null, 404);
  }));
  const { default: SettingsPage } = await import('./page');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /></NextIntlClientProvider>); });
  await flush();
}

const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll('button')] as HTMLButtonElement[];
/** the button whose visible text is exactly `text` (the n-th such one) */
const btn = (text: string, scope: ParentNode = document, n = 0) => buttons(scope).filter((b) => b.textContent?.trim() === text)[n]!;
const labelOf = (input: HTMLInputElement) => (input.labels?.[0]?.textContent ?? '').trim();
/** a text box found by its words: the placeholder (old screen) or its visible name (new screen) */
const boxes = (name: string) => [...document.querySelectorAll('input')].filter((i) => i.placeholder === name || labelOf(i) === name) as HTMLInputElement[];
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const press = async (el: HTMLElement) => { await act(async () => { el.click(); }); await flush(); };


async function createProjectNamed(name: string) {
  await type(boxes(T.projectNamePlaceholder).slice(-1)[0]!, name);
  await press(btn(T.createProjectAction));
}

describe('[SID:4906] settings › 프로젝트: a project made from the chat list comes BACK to the list', () => {
  it('⭐started at the chat list (return=chats): after «만들기» the person goes to /chats on the NEW project (where «에이전트 추가» already stands)', async () => {
    await mountPage('tab=projects&return=chats');
    await createProjectNamed('감마');
    expect(projectCalls).toHaveLength(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/chats?p=p3'); // reverted (no return) → never called
  });

  it('⭐started in settings itself (no return): the person stays — nothing is pushed', async () => {
    await mountPage('tab=projects');
    await createProjectNamed('감마');
    expect(projectCalls).toHaveLength(1);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('⭐the word is a whitelist of ONE value, not an address: return=//evil.com · return=/organization · return=chats2 send nobody anywhere', async () => {
    for (const q of ['tab=projects&return=//evil.com', 'tab=projects&return=/organization', 'tab=projects&return=chats2']) {
      pushMock.mockClear();
      await mountPage(q);
      await createProjectNamed('감마');
      expect(pushMock).not.toHaveBeenCalled();
      await act(async () => { root.unmount(); });
      container.remove(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
      projectCalls = [];
    }
  });

  it('a project that was NOT made (the request failed) does not send the person back', async () => {
    await mountPage('tab=projects&return=chats');
    const f = vi.mocked(globalThis.fetch);
    f.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    await createProjectNamed('감마');
    expect(projectCalls).toHaveLength(0); // the intercepted call WAS the POST (the normal mock records it)
    expect(pushMock).not.toHaveBeenCalled();
  });
});
