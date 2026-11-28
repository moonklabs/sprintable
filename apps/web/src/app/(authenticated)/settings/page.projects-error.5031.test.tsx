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

const { useDashboardContextMock, captured } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  // the props the page hands to its two project components, every render (the REAL components still draw; this only lets a test call an old or a current callback by hand)
  captured: { deleteConfirms: [] as Array<() => void>, editSaves: [] as Array<() => void> },
}));
vi.mock('@/components/settings/project-delete-dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/settings/project-delete-dialog')>();
  const { createElement } = await import('react');
  return { ...actual, ProjectDeleteDialog: (p: Parameters<typeof actual.ProjectDeleteDialog>[0]) => { captured.deleteConfirms.push(p.onConfirm); return createElement(actual.ProjectDeleteDialog, p); } };
});
vi.mock('@/components/settings/projects-section', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/settings/projects-section')>();
  const { createElement } = await import('react');
  return { ...actual, ProjectsSection: (p: Parameters<typeof actual.ProjectsSection>[0]) => { captured.editSaves.push(p.onEditSave); return createElement(actual.ProjectsSection, p); } };
});
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.settings;
const C = koMessages.common;
let container: HTMLDivElement;
let root: Root;
let projectListUrls: string[];
let writes: Array<{ method: string; url: string }>;
let projectPostImpl: (() => unknown) | null = null; // a project create (POST) the test holds in flight

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  projectListUrls = [];
  commitTexts.length = 0;
  commitInputValues.length = 0;
  captured.deleteConfirms.length = 0;
  captured.editSaves.length = 0;
  projectPostImpl = null;
  writes = [];
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
    if (url.startsWith('/api/projects/') && (method === 'DELETE' || method === 'PATCH')) { writes.push({ method, url }); return method === 'DELETE' ? json({ ok: true }) : json({ id: 'p-a', name: '바뀐이름', description: null }); }
    if (url === '/api/projects' && method === 'POST' && projectPostImpl) return projectPostImpl() as ReturnType<typeof json>;
    return json(null, 404);
  }));
  await render();
}
// what the DOM said at the end of EVERY commit (a layout effect runs in the commit, before the passive effects that clear/refresh the list) — so the very first frame after an organization switch can be read
const commitTexts: string[] = [];
const commitInputValues: string[][] = [];
function CommitProbe() {
  useLayoutEffect(() => { commitTexts.push(document.body.textContent ?? ''); commitInputValues.push([...document.querySelectorAll('input')].map((i) => i.value)); });
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

// a held request the test never made must fail the test (a no-op default would let it pass without the request ever being held)
const notHeld = (what: string) => () => { throw new Error(`the held request «${what}» was never made`); };
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
    let release: (v: unknown) => void = notHeld('release');
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
    let failOld: (v: unknown) => void = notHeld('failOld');
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
    let release: (v: unknown) => void = notHeld('release');
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
    let throwOld: (e: unknown) => void = notHeld('throwOld');
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

  // codex 2 (MEDIUM): a create started in organization A that finishes after the person switched to B ran A's closure of `refreshProjects` (it took the shared ticket and turned the list back to A) — B's read was dropped, B's tab stuck on loading, and A's success line stood under B.
  const typeInto = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const nameBox = () => [...document.querySelectorAll('input')].filter((i) => i.placeholder === T.projectNamePlaceholder || (i.labels?.[0]?.textContent ?? '').trim() === T.projectNamePlaceholder).slice(-1)[0] as HTMLInputElement;
  const pressCreate = async () => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === T.createProjectAction) as HTMLButtonElement;
    await act(async () => { b.click(); });
  };

  it('⭐(g) a create that finishes AFTER the switch to another organization neither drops the new organization\'s read nor leaves its success line there', async () => {
    let finishCreate: (v: unknown) => void = notHeld('finishCreate');
    let releaseNew: (v: unknown) => void = notHeld('releaseNew');
    projectPostImpl = () => new Promise((resolve) => { finishCreate = resolve; });
    await mountPage('tab=projects', (url) => (url.includes('org_id=org-1')
      ? json([{ id: 'p-a', name: '첫째조직프로젝트', description: null }])
      : new Promise((resolve) => { releaseNew = resolve; })));
    await typeInto(nameBox(), '새프로젝트');
    await pressCreate(); // started in org-1 (its closure holds org-1)
    await switchOrgTo('org-2'); // org-2's read is out
    await act(async () => { finishCreate({ ok: true, status: 201, json: async () => ({ data: { id: 'p-new', name: '새프로젝트' } }) }); }); // the org-1 create ends now
    await flush();
    await act(async () => { releaseNew(json([{ id: 'p-b', name: '둘째조직프로젝트', description: null }])); });
    await flush();
    expect(hasText('둘째조직프로젝트')).toBe(true); // reverted → the org-1 closure took the ticket: org-2's answer is dropped and the tab stays on loading
    expect(hasText('새프로젝트')).toBe(false); // …and org-1's row / «만들었어요» line is not shown under org-2
    expect(hasText(T.projectCreated.replace('{name}', '새프로젝트'))).toBe(false);
    expect(projectListUrls.filter((u) => u.includes('org_id=org-1'))).toHaveLength(1); // no org-1 re-read after the switch
  });

  // codex 3 (MEDIUM): the delete confirmation / the edit row / the result line are about a project of ONE organization; after an in-place switch the first frame must not hold them, and nothing may be sent for them.
  const press = async (label: string) => {
    const b = [...document.querySelectorAll('button')].filter((x) => x.getAttribute('aria-label') === label || x.textContent?.trim() === label).pop() as HTMLButtonElement | undefined; // the LAST match: a dialog sits at the end of the body
    if (!b) throw new Error(`no button «${label}»`);
    await act(async () => { b.click(); });
  };
  const rowsOfOrg1 = (url: string) => (url.includes('org_id=org-1') ? json([{ id: 'p-a', name: '알파', description: null }]) : new Promise(() => {}));

  it('(h) the same organization works as before: delete → ask → confirm sends ONE DELETE for that project and says so', async () => {
    await mountPage('tab=projects', rowsOfOrg1);
    await press(`${T.deleteProject} — 알파`);
    expect(hasText(T.projectDeleteConfirmTitle)).toBe(true);
    await press(T.deleteProject); // the dialog's own «삭제»
    await flush();
    expect(writes).toEqual([{ method: 'DELETE', url: '/api/projects/p-a' }]);
    expect(hasText(T.projectDeleted)).toBe(true);
    expect(hasText(T.projectDeleteConfirmTitle)).toBe(false);
  });

  it('⭐(i) a delete confirmation left open in organization 1 is not on the screen of organization 2 — not in the first frame, and nothing is deleted', async () => {
    await mountPage('tab=projects', rowsOfOrg1);
    await press(`${T.deleteProject} — 알파`);
    expect(hasText(T.projectDeleteConfirmTitle)).toBe(true); // the confirmation really is open
    const mark = commitTexts.length;
    await switchOrgTo('org-2');
    expect(commitTexts.length).toBeGreaterThan(mark);
    expect(commitTexts.slice(mark).some((t) => t.includes(T.projectDeleteConfirmTitle))).toBe(false); // reverted (raw id) → the first frame still asks, and its «삭제» deletes organization 1's project
    expect(hasText(T.projectDeleteConfirmTitle)).toBe(false);
    expect(writes).toEqual([]);
  });

  it('⭐(j) a row being edited in organization 1 is not an edit in organization 2 — no draft box in the first frame, nothing is sent', async () => {
    await mountPage('tab=projects', rowsOfOrg1);
    await press(`${C.edit} — 알파`);
    expect([...document.querySelectorAll('input')].map((i) => i.value)).toContain('알파'); // the edit boxes really are open with the draft
    const mark = commitInputValues.length;
    await switchOrgTo('org-2');
    expect(commitInputValues.length).toBeGreaterThan(mark);
    expect(commitInputValues.slice(mark).some((v) => v.includes('알파'))).toBe(false);
    expect(writes).toEqual([]);
  });

  it('⭐(k) the result line of organization 1 is not under organization 2 — not even in the first frame', async () => {
    await mountPage('tab=projects', rowsOfOrg1);
    await press(`${T.deleteProject} — 알파`);
    await press(T.deleteProject);
    await flush();
    expect(hasText(T.projectDeleted)).toBe(true);
    const mark = commitTexts.length;
    await switchOrgTo('org-2');
    expect(commitTexts.length).toBeGreaterThan(mark);
    expect(commitTexts.slice(mark).some((t) => t.includes(T.projectDeleted))).toBe(false); // reverted (raw message) → organization 1's line is under organization 2
    expect(hasText(T.projectDeleted)).toBe(false);
  });

  it('⭐(l) coming BACK to organization 1 does not bring its old delete confirmation or edit row back', async () => {
    await mountPage('tab=projects', (url) => (url.includes('org_id=org-1') ? json([{ id: 'p-a', name: '알파', description: null }]) : json([])));
    await press(`${T.deleteProject} — 알파`);
    expect(hasText(T.projectDeleteConfirmTitle)).toBe(true);
    await switchOrgTo('org-2');
    await switchOrgTo('org-1');
    expect(hasText('알파')).toBe(true); // organization 1's list is back
    expect(hasText(T.projectDeleteConfirmTitle)).toBe(false); // reverted (no drop on leaving) → the question is asked again
    expect(writes).toEqual([]);
  });

  // codex 3 follow-up — the LAST lines of defence, called by hand: a callback the page handed out in organization 1 and that is still held after the switch must send nothing.
  it('⭐(m) the «삭제» callback held from organization 1 is called after the switch to organization 2: no DELETE is sent and nothing changes on the screen', async () => {
    await mountPage('tab=projects', rowsOfOrg1);
    await press(`${T.deleteProject} — 알파`);
    expect(captured.deleteConfirms.length).toBeGreaterThan(0); // the page really handed the dialog its «삭제»
    const oldConfirm = captured.deleteConfirms[captured.deleteConfirms.length - 1]!;
    await switchOrgTo('org-2');
    expect(hasText(T.projectDeleteConfirmTitle)).toBe(false); // the dialog is gone; only the held callback is left
    await act(async () => { oldConfirm(); });
    await flush();
    expect(writes).toEqual([]); // reverted (no check BEFORE the request) → DELETE /api/projects/p-a goes out from organization 2's screen
    expect(hasText(T.projectDeleted)).toBe(false);
    expect(hasText(T.projectDeleteFailed)).toBe(false);
    expect(hasText(T.projectDeleteConfirmTitle)).toBe(false);
  });

  it('⭐(n) the «저장» callback of organization 2\'s first render, called while organization 1\'s edit row was still held: no PATCH is sent (the edit does not carry over)', async () => {
    await mountPage('tab=projects', rowsOfOrg1);
    await press(`${C.edit} — 알파`);
    expect(captured.editSaves.length).toBeGreaterThan(0);
    const mark = captured.editSaves.length;
    await switchOrgTo('org-2');
    expect(captured.editSaves.length).toBeGreaterThan(mark);
    const firstSaveOfOrg2 = captured.editSaves[mark]!; // what the page handed the section in organization 2's FIRST render (the effect that drops the edit has not run yet)
    await act(async () => { firstSaveOfOrg2(); });
    await flush();
    expect(writes).toEqual([]); // reverted (the edit row taken raw) → PATCH /api/projects/p-a goes out from organization 2's screen
  });

  it('(o) the «저장» callback held from organization 1 is called after the switch: no PATCH either', async () => {
    await mountPage('tab=projects', rowsOfOrg1);
    await press(`${C.edit} — 알파`);
    const oldSave = captured.editSaves[captured.editSaves.length - 1]!;
    await switchOrgTo('org-2');
    await act(async () => { oldSave(); });
    await flush();
    expect(writes).toEqual([]);
    expect(hasText(T.projectUpdated)).toBe(false);
  });
});
