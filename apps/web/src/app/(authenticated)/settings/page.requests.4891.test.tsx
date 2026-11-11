// @vitest-environment jsdom
//
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
const C = koMessages.common;
let container: HTMLDivElement;
let root: Root;
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

async function mountPage(tab: 'projects' | 'organization') {
  vi.doMock('next/navigation', () => {
    const params = new URLSearchParams(`tab=${tab}`); // a stable reference, like Next's
    return { useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => params, usePathname: () => '/settings' };
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
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;

describe('[SID:4891] settings › 프로젝트: what each press sends is unchanged', () => {
  it('the list shows both projects, the current one marked, and an admin has edit + delete on each row', async () => {
    await mountPage('projects');
    expect(document.body.textContent).toContain('알파');
    expect(document.body.textContent).toContain('베타');
    expect(document.body.textContent).toContain(T.currentProjectBadge);
    expect(buttons().filter((b) => b.textContent?.trim() === C.edit)).toHaveLength(2);
    expect(buttons().filter((b) => b.textContent?.trim() === T.deleteProject)).toHaveLength(2);
  });

  it('create: POST /api/projects {org_id, name (trimmed), description (trimmed or null)}', async () => {
    await mountPage('projects');
    const [nameBox] = boxes(T.projectNamePlaceholder).slice(-1);
    const [descBox] = boxes(T.projectDescriptionPlaceholder).slice(-1);
    expect(btn(T.createProjectAction).disabled).toBe(true); // nothing typed yet
    await type(nameBox!, '  감마  ');
    expect(btn(T.createProjectAction).disabled).toBe(false);
    await press(btn(T.createProjectAction));
    expect(projectCalls).toEqual([{ url: '/api/projects', method: 'POST', body: { org_id: 'org-1', name: '감마', description: null } }]);
    projectCalls.length = 0;
    await type(boxes(T.projectNamePlaceholder).slice(-1)[0]!, '델타');
    await type(descBox!, ' 설명 ');
    await press(btn(T.createProjectAction));
    expect(projectCalls).toEqual([{ url: '/api/projects', method: 'POST', body: { org_id: 'org-1', name: '델타', description: '설명' } }]);
  });

  it('edit: the row opens two boxes with its values; «저장» sends PATCH /api/projects/<id> {name (trimmed), description (trimmed or null)}; «취소» closes without a request', async () => {
    await mountPage('projects');
    await press(btn(C.edit, document, 0)); // 베타 (the page sorts by name: 베타 comes before 알파)
    const edit = boxes(T.projectNamePlaceholder)[0]!;
    expect(edit.value).toBe('베타');
    expect(boxes(T.projectDescriptionPlaceholder)[0]!.value).toBe('');
    await press(btn(C.cancel));
    expect(boxes(T.projectNamePlaceholder)).toHaveLength(1); // only the «new project» box is left
    expect(projectCalls).toEqual([]);
    await press(btn(C.edit, document, 0));
    await type(boxes(T.projectNamePlaceholder)[0]!, ' 베타 둘 ');
    await type(boxes(T.projectDescriptionPlaceholder)[0]!, ' 설명 ');
    await press(btn(C.save));
    expect(projectCalls).toEqual([{ url: '/api/projects/p2', method: 'PATCH', body: { name: '베타 둘', description: '설명' } }]);
  });

  it('edit: a cleared description is sent as null (not as an empty text)', async () => {
    await mountPage('projects');
    await press(btn(C.edit, document, 1)); // 알파 (second: the list is sorted by name) — its description is «첫째»
    expect(boxes(T.projectDescriptionPlaceholder)[0]!.value).toBe('첫째');
    await type(boxes(T.projectDescriptionPlaceholder)[0]!, '   ');
    await press(btn(C.save));
    expect(projectCalls).toEqual([{ url: '/api/projects/p1', method: 'PATCH', body: { name: '알파', description: null } }]);
  });

  it('delete: «삭제» asks first (a window), «취소» sends nothing, the red button sends DELETE /api/projects/<id>', async () => {
    await mountPage('projects');
    await press(btn(T.deleteProject, document, 1)); // 알파 (second: sorted by name)
    expect(dialog()?.textContent).toContain(T.projectDeleteConfirmTitle);
    expect(projectCalls).toEqual([]);
    await press(btn(C.cancel, dialog()));
    expect(dialog()).toBeNull();
    expect(projectCalls).toEqual([]);
    await press(btn(T.deleteProject, document, 1));
    await press(btn(T.deleteProject, dialog()));
    expect(projectCalls).toEqual([{ url: '/api/projects/p1', method: 'DELETE', body: null }]);
  });
});

describe('[SID:4891] settings › 조직: «조직 삭제» sends what it sent', () => {
  async function openOrgDelete() {
    await mountPage('organization');
    await press(btn(T.orgDeleteTitle));
  }

  it('the impact is read: the name must be typed first; the body is {confirmation: the name, confirm_without_impact: false}', async () => {
    await openOrgDelete();
    expect(dialog()?.textContent).toContain(T.orgDeleteImpactTitle);
    const confirmBtn = btn(T.orgDeleteConfirmCta, dialog());
    expect(confirmBtn.disabled).toBe(true);
    await type(boxes('우리 조직')[0]!, '우리');
    expect(btn(T.orgDeleteConfirmCta, dialog()).disabled).toBe(true); // a part of the name is not the name
    await type(boxes('우리 조직')[0]!, '우리 조직');
    expect(btn(T.orgDeleteConfirmCta, dialog()).disabled).toBe(false);
    await press(btn(T.orgDeleteConfirmCta, dialog()));
    expect(orgCalls).toEqual([{ url: '/api/organizations/org-1', method: 'DELETE', body: { confirmation: '우리 조직', confirm_without_impact: false } }]);
  });

  it('the impact could not be read: no «go on» until the person acknowledges it; then the body says so (confirm_without_impact: true)', async () => {
    impactOk = false;
    await openOrgDelete();
    expect(dialog()?.textContent).toContain(T.orgDeleteImpactUnavailable);
    await type(boxes('우리 조직')[0]!, '우리 조직');
    expect(btn(T.orgDeleteConfirmCta, dialog()).disabled).toBe(true); // the name alone is not enough while the impact is unknown
    const ack = [...dialog().querySelectorAll('[role="checkbox"], input[type="checkbox"]')][0] as HTMLElement;
    await press(ack);
    expect(btn(T.orgDeleteConfirmCta, dialog()).disabled).toBe(false);
    await press(btn(T.orgDeleteConfirmCta, dialog()));
    expect(orgCalls).toEqual([{ url: '/api/organizations/org-1', method: 'DELETE', body: { confirmation: '우리 조직', confirm_without_impact: true } }]);
  });

  it('«취소» closes the window without a request', async () => {
    await openOrgDelete();
    await press(btn(C.cancel, dialog()));
    expect(dialog()).toBeNull();
    expect(orgCalls).toEqual([]);
  });
});
