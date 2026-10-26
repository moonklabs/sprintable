// @vitest-environment jsdom
//
// story 4711 — 처음 셋업 세 걸음(에이전트 → 폴더 → 시작): one card · the folder comes back from the app's Mac window in the `#` ·
// [시작] = one confirm-solo with the runtime and the folder's NAME (never a path) · the free plan's one project asks instead of 402.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { ctx, sp } = vi.hoisted(() => ({ ctx: vi.fn(), sp: { value: null as URLSearchParams | null } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx() }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useSearchParams: () => sp.value }));
const { ee } = vi.hoisted(() => ({ ee: { on: false } }));
vi.mock('@/lib/ee', () => ({ isEEEnabled: () => ee.on }));

import { DesktopSetupEntry } from './desktop-setup';
import { DesktopSetupQuick } from './desktop-setup-quick';
import { SetupProgressView } from './desktop-setup-progress';
import { parseSetupFragment } from '@/lib/desktop-setup';
import { appSetupLink } from '@/lib/auth/native-return-app';
import { __resetOrgRemoteControlForTest } from '@/lib/org-remote-control';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const PROJ = '11111111-1111-4111-8111-111111111111';
let container: HTMLDivElement;
let root: Root;
let calls: { url: string; method?: string; body?: unknown }[];
let confirmNow: () => Response;
/** what GET /api/invites/mine answers now (default: none) — story 4711 AC4 reads its failure */
let invitesNow: () => Response | Promise<Response> = () => new Response(JSON.stringify({ invites: [] }), { status: 200 });
/** story 4717: what GET /api/desktop/recipes answers (default 404 — no room read: the card as before) */
let recipesNow: () => Response = () => new Response('{}', { status: 404 });
/** what GET /api/desktop/setups/{id} answers (the progress view's reading) */
let statusNow: () => unknown = () => ({});
/** story 4670: what GET /api/organizations/{id}/remote-control answers now, and the PUT (default: not known → the page reads it as a failed read) */
let remoteGet: () => Response = () => new Response('{}', { status: 404 });
let remotePut: () => Response = () => new Response(JSON.stringify({ data: { enabled: true, can_change: true, enabled_at: 'now' } }), { status: 200 });
const remoteOf = (v: object) => () => new Response(JSON.stringify({ data: v }), { status: 200 });

function stub() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.method ? { method: init.method } : {}), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/api/desktop/setup-codes/confirm-solo')) return confirmNow();
    if (url.endsWith('/api/desktop/recipes')) return recipesNow(); // story 4717: the plan's agent room rides on the recipe list
    if (/\/api\/organizations\/[^/]+\/remote-control$/.test(url)) return init?.method === 'PUT' ? remotePut() : remoteGet();
    if (url.endsWith('/api/invites/mine')) return invitesNow();
    if (url === '/api/organizations' && init?.method === 'POST') return new Response(JSON.stringify({ data: { id: 'o-mine' } }), { status: 200 }); // story 4721
    if (url === '/api/switch-org') return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ data: { display_name: '김지우', email: 'a@b.c', email_verified: true, email_verification_required: true } }), { status: 200 });
    if (url.endsWith('/api/auth/refresh')) return new Response('{}', { status: 200 });
    if (url.endsWith('/api/current-project')) return new Response('{}', { status: 200 });
    if (url.includes('/api/desktop/setups/')) return new Response(JSON.stringify(statusNow()), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
}
const frag = (extra: string) => `#code=${CODE}&setup=11111111-1111-4111-8111-aaaaaaaaaaaa&runtimes=claude,codex&caps=move,solo&rv=claude:2.1.289,codex:0.159.3${extra}`;
async function mount(hash: string, opts: { role?: string; projects?: { projectId: string; projectName: string; orgId?: string }[]; orgId?: string | null; projectId?: string } = {}, locale: 'ko' | 'en' = 'ko') {
  ctx.mockReturnValue({
    projectId: opts.projectId, currentProjectSlug: 'proj', userName: '김지우', orgId: opts.orgId === undefined ? 'o-1' : opts.orgId,
    orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: opts.role ?? 'owner' }], projectMemberships: opts.projects ?? [],
  });
  const query = parseSetupFragment(hash)!;
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><DesktopSetupQuick query={query} onTeam={() => { teamPressed = true; }} /></NextIntlClientProvider>); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
let teamPressed = false;
const text = () => container.textContent ?? '';
const buttonOf = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const linkOf = (label: string) => [...container.querySelectorAll('a')].find((a) => a.textContent === label) as HTMLAnchorElement | undefined;

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  confirmNow = () => new Response(JSON.stringify({ project_id: PROJ, conversation_id: 'c-1', members: [] }), { status: 200 });
  invitesNow = () => new Response(JSON.stringify({ invites: [] }), { status: 200 });
  recipesNow = () => new Response('{}', { status: 404 }); statusNow = () => ({}); __resetOrgRemoteControlForTest(); teamPressed = false; ee.on = false; sp.value = null; remoteGet = remoteOf({ enabled: true, can_change: true, enabled_at: 'now' }); remotePut = () => new Response(JSON.stringify({ data: { enabled: true, can_change: true, enabled_at: 'now' } }), { status: 200 }); stub();
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('[SID:4711] the first setup in three steps', () => {
  it('opens with the program picked, the folder button, and [시작] off with its reason in view', async () => {
    await mount(frag(''), { projects: [] });
    expect(text()).toContain('에이전트 만들기');
    expect((container.querySelector('input[name=quick-runtime]:checked')!.parentElement)!.textContent).toContain('Claude Code');
    expect(text()).toContain('2.1.289'); // the version after the name
    expect(linkOf('폴더 고르기')!.getAttribute('href')).toBe('ai.sprintable:/desktop/setup?intent=folder&pick=claude');
    expect(buttonOf('만들기')!.disabled).toBe(true);
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toBe('폴더를 고르면 만들 수 있어요'); // a line, not a tooltip
    expect(text()).toContain('여러 에이전트로 팀 꾸리기 →');
  });

  it('the person\'s program pick goes to the folder window and comes back (the address is new)', async () => {
    await mount(frag('&pick=codex'));
    expect((container.querySelector('input[name=quick-runtime]:checked')!.parentElement)!.textContent).toContain('Codex');
    expect(linkOf('폴더 고르기')!.getAttribute('href')).toBe('ai.sprintable:/desktop/setup?intent=folder&pick=codex');
  });

  it('a folder from the window: its path, the project line by the folder\'s name, [시작] on — and one confirm-solo with the NAME only', async () => {
    await mount(frag('&fshown=~/code/my-app&fname=my-app'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Existing', orgId: 'o-1' }] });
    expect(container.querySelector('[data-testid=quick-folder]')!.textContent).toBe('~/code/my-app');
    expect(container.querySelector('[data-testid=quick-project]')!.textContent).toBe('프로젝트 이름 · my-app');
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toBe('만들기를 누르면 이 조직에 에이전트가 하나 생겨요 · 이름 Claude Code · 도구 Claude Code · 프로젝트 my-app');
    expect(buttonOf('만들기')!.disabled).toBe(false);
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const post = calls.find((c) => c.url.endsWith('/confirm-solo'))!;
    expect(post.body).toEqual({ code: CODE, runtime: 'claude', project_name: 'my-app', agent_name: 'Claude Code', folder_name: 'my-app' }); // no path, no workdir
    expect(JSON.stringify(calls)).not.toContain('~/code');
  });

  it('codex self-QA: two presses of [시작] before the screen redraws send ONE confirmation', async () => {
    await mount(frag('&fshown=~/code/my-app&fname=my-app'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Existing', orgId: 'o-1' }] });
    const go = buttonOf('만들기')!;
    await act(async () => { go.click(); go.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.filter((c) => c.url.endsWith('/confirm-solo')).length).toBe(1);
  });

  it('codex self-QA: a folder name that is a path (a made-up link) is no answer — nothing is sent, the button asks for the folder', async () => {
    for (const name of ['/Users/me/repo', 'a/b', 'a\\b', '  ']) {
      await mount(frag(`&fshown=~/code/my-app&fname=${encodeURIComponent(name)}`), { projectId: PROJ, projects: [] });
      expect(container.querySelector('[data-testid=quick-folder]')).toBeNull();
      expect(buttonOf('만들기')!.disabled).toBe(true);
      expect(calls.filter((c) => c.url.includes('confirm-solo'))).toEqual([]);
      await act(async () => { root.render(<div />); });
    }
  });

  it('a project the app found for this folder is used (by id), and the line says so', async () => {
    await mount(frag(`&fshown=~/code/my-app&fname=my-app&fproject=${PROJ}`), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Existing', orgId: 'o-1' }] });
    expect(container.querySelector('[data-testid=quick-project]')!.textContent).toBe('이 폴더의 프로젝트 · Existing');
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.find((c) => c.url.endsWith('/confirm-solo'))!.body).toEqual({ code: CODE, runtime: 'claude', project_id: PROJ, agent_name: 'Claude Code', folder_name: 'my-app' });
  });

  it('a project id this organization does not have is not sent — a new project by the folder\'s name (the server would 404 it)', async () => {
    await mount(frag(`&fshown=~/code/my-app&fname=my-app&fproject=${PROJ}`), { projectId: PROJ, projects: [] });
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.find((c) => c.url.endsWith('/confirm-solo'))!.body).toEqual({ code: CODE, runtime: 'claude', project_name: 'my-app', agent_name: 'Claude Code', folder_name: 'my-app' });
  });

  it('a project name this organization has shows as «{name} 2» (the server makes the final one by the same rule)', async () => {
    await mount(frag('&fshown=~/a/app&fname=app'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'App', orgId: 'o-1' }] });
    expect(container.querySelector('[data-testid=quick-project]')!.textContent).toBe('프로젝트 이름 · app 2');
  });

  it('the home folder or the top of the disk asks once and holds [시작] until «맞아요»', async () => {
    await mount(frag('&fshown=~&fname=yoonjae&fwide=1'));
    expect(container.querySelector('[data-testid=quick-wide]')!.textContent).toContain('이 폴더 전체에서 일해요 — 맞나요?');
    expect(buttonOf('만들기')!.disabled).toBe(true);
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toBe('폴더를 확인하면 만들 수 있어요');
    await act(async () => { buttonOf('맞아요')!.click(); });
    expect(buttonOf('만들기')!.disabled).toBe(false);
    expect(container.querySelector('[data-testid=quick-wide]')).toBeNull(); // Yuna 5121 ②: once confirmed the question is gone
    expect(text()).not.toContain('이 폴더 전체에서 일해요');
    expect(linkOf('폴더 바꾸기') ?? linkOf('바꾸기')).toBeTruthy(); // the folder can still be changed
  });

  it('a refused window answer says why and keeps the button; a cancel shows nothing', async () => {
    await mount(frag('&frefused=denied'));
    expect(container.querySelector('[data-testid=quick-refused]')!.textContent).toContain('시스템 설정 › 개인정보 보호 및 보안 › 파일 및 폴더');
    expect(linkOf('폴더 고르기')).toBeTruthy();
  });

  it('the app\'s own folder and a non-folder have their own lines (Yuna 5121 ④)', async () => {
    await mount(frag('&frefused=app_folder'));
    expect(container.querySelector('[data-testid=quick-refused]')!.textContent).toBe('Sprintable 앱이 쓰는 폴더라 고를 수 없어요 — 다른 폴더를 골라 주세요');
    await act(async () => { root.render(<div />); });
    await mount(frag('&frefused=not_folder'));
    expect(container.querySelector('[data-testid=quick-refused]')!.textContent).toBe('고른 항목이 폴더가 아니에요 — 폴더를 골라 주세요');
    await act(async () => { root.render(<div />); });
    await mount(frag('&frefused=missing'));
    expect(container.querySelector('[data-testid=quick-refused]')!.textContent).toBe('고른 폴더를 찾을 수 없어요 — 다시 골라 주세요');
    await act(async () => { root.render(<div />); });
    await mount(frag('&frefused=app_folder'), {}, 'en');
    expect(container.querySelector('[data-testid=quick-refused]')!.textContent).toBe('This folder is used by the Sprintable app itself — choose another folder');
  });

  it('English words', async () => {
    await mount(frag('&fshown=~/code/my-app&fname=my-app'), { projectId: PROJ }, 'en');
    expect(text()).toContain('Create an agent');
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toBe('Pressing Create adds one agent to this organization · name Claude Code · tool Claude Code · project my-app');
    expect(text()).toContain('Set up a team of agents →');
  });

  it('only one program found: no radio, the name and its version', async () => {
    await mount(`#code=${CODE}&runtimes=codex&caps=solo&rv=codex:0.159.3`);
    expect(container.querySelector('input[name=quick-runtime]')).toBeNull();
    expect(text()).toContain('Codex');
    expect(text()).toContain('0.159.3');
  });

  it('nothing found: the no-agent block with an install line each and «다시 찾기»; steps ② ③ are not drawn', async () => {
    await mount(`#code=${CODE}&runtimes=&caps=solo`);
    expect(container.querySelector('[data-testid=quick-no-agent]')!.textContent).toContain('이 컴퓨터에서 Claude Code나 Codex를 찾지 못했어요');
    expect(container.querySelectorAll('code').length).toBe(2);
    const rows = [...container.querySelectorAll('[data-testid=quick-no-agent] li')].map((li) => li.firstElementChild!.textContent);
    expect(rows).toEqual(['Claude Code', 'Codex']); // Yuna 5121 ③: each row starts with the program's name
    expect(linkOf('다시 찾기')!.getAttribute('href')).toBe('ai.sprintable:/desktop/setup');
    expect(buttonOf('만들기')).toBeUndefined();
  });

  it('a person who is not an owner/admin sees the not-admin card, not the form', async () => {
    await mount(frag(''), { role: 'member' });
    expect(text()).not.toContain('에이전트 만들기');
  });

  it('the free plan\'s one project: the 402 names it, the card asks, and «넣고 시작» sends THAT project — nothing was put there before', async () => {
    ee.on = true;
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project', limit: 1, existing_project: { id: PROJ, name: 'Mine' } } }), { status: 402 });
    await mount(frag('&fshown=~/new/folder&fname=folder'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Mine', orgId: 'o-1' }] });
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const ask = container.querySelector('[data-testid=quick-limit]')!;
    expect(ask.textContent).toContain('무료 플랜은 프로젝트가 하나예요');
    expect(ask.textContent).toContain('이 폴더의 에이전트를 Mine 프로젝트에 넣어 만들 수 있어요 — 에이전트는 이 폴더에서 일해요.');
    expect(ask.textContent).toContain('요금제 업그레이드 →'); // billing open
    expect(container.querySelector('[data-testid=quick-project]')!.textContent).toBe('프로젝트 · Mine');
    expect(buttonOf('만들기')).toBeUndefined(); // Yuna 5121 ①: the one primary on the card is «넣고 시작» — no [시작] beside it
    expect(container.querySelector('[data-testid=quick-start-line]')).toBeNull();
    confirmNow = () => new Response(JSON.stringify({ project_id: PROJ, conversation_id: 'c-1', members: [] }), { status: 200 });
    await act(async () => { buttonOf('넣고 만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const posts = calls.filter((c) => c.url.endsWith('/confirm-solo'));
    expect(posts.map((p) => p.body)).toEqual([{ code: CODE, runtime: 'claude', project_name: 'folder', agent_name: 'Claude Code', folder_name: 'folder' }, { code: CODE, runtime: 'claude', project_id: PROJ, agent_name: 'Claude Code', folder_name: 'folder' }]);
  });

  it('codex self-QA: the «넣고 시작» question belongs to the folder it was asked for — another folder picked afterwards asks again, never starts into the first one\'s project', async () => {
    ee.on = true;
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project', limit: 1, existing_project: { id: PROJ, name: 'Mine' } } }), { status: 402 });
    await mount(frag('&fshown=~/a/folder-a&fname=folder-a'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Mine', orgId: 'o-1' }] });
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid=quick-limit]')).not.toBeNull();
    // the window answers again with folder B (the same page, a new address)
    await mount(frag('&fshown=~/b/folder-b&fname=folder-b'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Mine', orgId: 'o-1' }] });
    expect(container.querySelector('[data-testid=quick-limit]')).toBeNull();
    expect(buttonOf('넣고 만들기')).toBeUndefined();
    expect(buttonOf('만들기')!.disabled).toBe(false);
    confirmNow = () => new Response(JSON.stringify({ project_id: PROJ, conversation_id: 'c-1', members: [] }), { status: 200 });
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const posts = calls.filter((c) => c.url.endsWith('/confirm-solo')).map((p) => p.body);
    expect(posts.at(-1)).toEqual({ code: CODE, runtime: 'claude', project_name: 'folder-b', agent_name: 'Claude Code', folder_name: 'folder-b' }); // B by its own name — not A's project id
  });

  it('codex self-QA: a started setup puts #progress=<setup id> on the address, so a reload goes back to the progress (the code is not in it)', async () => {
    await mount(frag('&fshown=~/code/my-app&fname=my-app'), { projectId: PROJ, projects: [] });
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(window.location.hash).toBe('#progress=11111111-1111-4111-8111-aaaaaaaaaaaa');
    expect(window.location.href).not.toContain(CODE);
  });

  it('codex self-QA: the progress and the reload address use the setup the SERVER made (its answer), not only the address\'s setup=; an invalid id from the answer falls back to the address', async () => {
    const SERVER_ID = '33333333-3333-4333-8333-cccccccccccc';
    confirmNow = () => new Response(JSON.stringify({ setup_id: SERVER_ID, project_id: PROJ, conversation_id: 'c-1', members: [] }), { status: 200 });
    await mount(frag('&fshown=~/code/my-app&fname=my-app'), { projectId: PROJ, projects: [] });
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(window.location.hash).toBe(`#progress=${SERVER_ID}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); // the progress view's first reading is on the next task (setTimeout 0)
    expect(calls.some((c) => c.url.includes(`/api/desktop/setups/${SERVER_ID}`))).toBe(true); // the progress reads THAT setup
    // a nonsense id in the answer is not trusted: the address's own setup id stands
    await act(async () => { root.render(<div />); });
    calls.length = 0;
    confirmNow = () => new Response(JSON.stringify({ setup_id: 's-1', project_id: PROJ, conversation_id: 'c-1', members: [] }), { status: 200 }); // not a uuid (also 'a/../b' · a code-like string in the move test)
    await mount(frag('&fshown=~/code/my-app&fname=my-app'), { projectId: PROJ, projects: [] });
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(window.location.hash).toBe('#progress=11111111-1111-4111-8111-aaaaaaaaaaaa');
  });

  it('codex self-QA: while the start is going out the team-path link is off (it would unmount the card and leave the finished start on a page that shows the recipe)', async () => {
    confirmNow = () => new Promise<Response>(() => { /* never answers */ }) as unknown as Response;
    await mount(frag('&fshown=~/code/my-app&fname=my-app'), { projectId: PROJ, projects: [] });
    expect(buttonOf('여러 에이전트로 팀 꾸리기 →')!.disabled).toBe(false);
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(buttonOf('여러 에이전트로 팀 꾸리기 →')!.disabled).toBe(true);
    expect(teamPressed).toBe(false);
  });

  it('codex self-QA: an address whose setup= is not a uuid and an answer without a valid id → the plain «started» card, NO progress route is ever read with the bad id', async () => {
    confirmNow = () => new Response(JSON.stringify({ project_id: PROJ, conversation_id: 'c-1', members: [] }), { status: 200 });
    await mount(frag('&fshown=~/code/my-app&fname=my-app').replace('setup=11111111-1111-4111-8111-aaaaaaaaaaaa', 'setup=s-1'), { projectId: PROJ, projects: [] });
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    expect(calls.some((c) => c.url.includes('/api/desktop/setups/s-1'))).toBe(false);
    expect(window.location.hash).not.toContain('s-1');
  });

  it('story 4711 AC4: the invites cannot be read → the card says so in place (no redirect to a «조직 만들기» screen), nothing is made; [다시 확인] reads again', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign } as unknown as Location);
    invitesNow = () => new Response('{}', { status: 503 });
    await mount(frag('&fshown=~/code/my-app&fname=my-app'), { orgId: null, role: 'owner', projects: [] });
    expect(assign).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid=setup-invite-check-failed]')!.textContent).toContain('초대를 확인하지 못했어요 — 확인한 뒤에 조직을 만들어요');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    invitesNow = () => new Response(JSON.stringify({ invites: [] }), { status: 200 });
    await act(async () => { buttonOf('다시 확인')!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid=setup-invite-check-failed]')).toBeNull();
  });

  it('codex self-QA: two overlapping invite reads (StrictMode runs the effect twice) — a LATE failure does not overwrite the read that already succeeded', async () => {
    let n = 0;
    let failLate: (r: Response) => void = () => {};
    invitesNow = () => {
      n += 1;
      if (n === 1) return new Promise<Response>((resolve) => { failLate = resolve; }); // the first read answers last, with a failure
      return new Response(JSON.stringify({ invites: [] }), { status: 200 });          // the second answers at once: none → a new organization
    };
    ctx.mockReturnValue({ projectId: undefined, currentProjectSlug: 'proj', userName: '김지우', orgId: null, orgMemberships: [], projectMemberships: [] });
    const query = parseSetupFragment(frag('&fshown=~/code/my-app&fname=my-app'))!;
    await act(async () => { root.render(<StrictMode><NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopSetupQuick query={query} onTeam={() => {}} /></NextIntlClientProvider></StrictMode>); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(n).toBe(2);
    await act(async () => { failLate(new Response('{}', { status: 503 })); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid=setup-invite-check-failed]')).toBeNull(); // not the retry card
  });

  it('billing closed (prod today): the free-plan question has no upgrade link', async () => {
    ee.on = false;
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project', limit: 1, existing_project: { id: PROJ, name: 'Mine' } } }), { status: 402 });
    await mount(frag('&fshown=~/new/folder&fname=folder'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Mine', orgId: 'o-1' }] });
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid=quick-limit]')!.textContent).not.toContain('요금제 업그레이드');
  });

  it('«여러 에이전트로 팀 꾸리기 →» hands over to the recipe setup', async () => {
    await mount(frag(''));
    await act(async () => { buttonOf('여러 에이전트로 팀 꾸리기 →')!.click(); });
    expect(teamPressed).toBe(true);
  });
});

describe('[SID:4711] the page picks the card by what the app said', () => {
  it('an app that said solo gets the card; one from before gets the recipe setup as always', async () => {
    ctx.mockReturnValue({ projectId: PROJ, currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }], projectMemberships: [] });
    for (const [caps, want] of [['caps=move,solo', '에이전트 만들기'], ['caps=move', '이 컴퓨터에 에이전트를 만들어']] as const) {
      window.location.hash = `#code=${CODE}&runtimes=claude&${caps}`;
      await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopSetupEntry /></NextIntlClientProvider>); });
      for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
      if (caps === 'caps=move,solo') expect(text()).toContain(want); else expect(container.querySelector('[data-testid=quick-card]')).toBeNull();
      await act(async () => { root.render(<div />); });
    }
  });

  it('the folder link is the app\'s own scheme (default app)', () => {
    expect(appSetupLink(null, 'folder', { pick: 'codex' })).toBe('ai.sprintable:/desktop/setup?intent=folder&pick=codex');
    expect(appSetupLink(null, 'folder')).toBe('ai.sprintable:/desktop/setup?intent=folder');
    expect(appSetupLink(null, 'reopen', { pick: 'codex' })).toBe('ai.sprintable:/desktop/setup?intent=reopen'); // pick rides only on a folder ask
  });
});

describe('[SID:4670 AC1] «폰으로도 에이전트 다루기» on the three-step card (PO 10-16 correction)', () => {
  const OFF_OWNER = { enabled: false, can_change: true, enabled_at: null };
  const tick = () => container.querySelector('#quick-phone-control') as HTMLInputElement | null;
  const puts = () => calls.filter((c) => c.method === 'PUT' && c.url.includes('/remote-control'));
  const FOLDER = '&fshown=~/code/my-app&fname=my-app';
  const press = async () => { await act(async () => { buttonOf('만들기')!.click(); }); for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

  it('an owner of an organization whose remote control is OFF: one tick above [시작], ticked, with the words — and it sits in the start row (no new step)', async () => {
    remoteGet = remoteOf(OFF_OWNER);
    await mount(frag(FOLDER), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'P', orgId: 'o-1' }] });
    expect(tick()?.checked).toBe(true);
    expect(container.querySelector('[data-testid=setup-phone-control]')!.textContent).toContain('폰으로도 에이전트 다루기');
    expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(1);
    const row = container.querySelector('[data-testid=setup-phone-control]')!;
    expect(row.nextElementSibling?.querySelector('button')?.textContent).toBe('만들기'); // just above «만들기»
  });

  it('already on · the person cannot change it → no row', async () => {
    for (const v of [{ enabled: true, can_change: true, enabled_at: 'x' }, { enabled: false, can_change: false, enabled_at: null }]) {
      remoteGet = remoteOf(v);
      await mount(frag(FOLDER), { projectId: PROJ });
      expect(tick()).toBeNull();
      await act(async () => { root.render(<div />); });
    }
  });

  it('[시작] → the confirmation goes through → ONE PUT {enabled:true} for this session\'s org, after it', async () => {
    remoteGet = remoteOf(OFF_OWNER);
    await mount(frag(FOLDER), { projectId: PROJ });
    await press();
    const order = calls.map((c) => (c.url.endsWith('/confirm-solo') ? 'confirm' : c.method === 'PUT' && c.url.includes('/remote-control') ? 'put' : null)).filter(Boolean);
    expect(order).toEqual(['confirm', 'put']);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.url).toContain('/api/organizations/o-1/remote-control');
    expect(puts()[0]!.body).toEqual({ enabled: true });
  });

  it('unticked → the start goes and NO switch call', async () => {
    remoteGet = remoteOf(OFF_OWNER);
    await mount(frag(FOLDER), { projectId: PROJ });
    await act(async () => { tick()!.click(); });
    await press();
    expect(calls.some((c) => c.url.endsWith('/confirm-solo'))).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it('a start that did not go through sends no PUT (the tick never rides on a failed confirmation)', async () => {
    remoteGet = remoteOf(OFF_OWNER);
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'something_else' } }), { status: 500 });
    await mount(frag(FOLDER), { projectId: PROJ });
    await press();
    expect(puts()).toHaveLength(0);
  });

  it('a read that FAILED draws the row too — unticked (an unreadable value is never flipped on by default)', async () => {
    remoteGet = () => new Response('{}', { status: 404 }); // a final «no» (a 5xx is asked again a little later) — failed, not «still reading»
    await mount(frag(FOLDER), { projectId: PROJ });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(tick()).not.toBeNull();
    expect(tick()!.checked).toBe(false);
    await press();
    expect(puts()).toHaveLength(0);
  });

  it('PO 10-16: the switch did NOT turn on → the conversation is not opened on its own: the line + [다시 켜기] · [대화 열기]; [다시 켜기] sends the PUT once more and then the conversation opens; [대화 열기] opens it at once', async () => {
    const SOLO = {
      setup_id: 's-1', device_name: 'Mac', state: 'handed_over', recipe_name: null, recipe: null, work_item_id: null, setup_kind: 'solo', conversation_id: 'c-1',
      members: [{ stage: null, role: null, member_id: 'm-1', kind: 'agent', runtime: 'claude', name: 'Claude Code' }],
      signals: { tools_connected: [], first_task_handed_at: null, first_result_at: null, workdir_fallback_at: null, blocked: null },
    };
    for (const how of ['again', 'open'] as const) {
      statusNow = () => SOLO;
      remoteGet = remoteOf(OFF_OWNER);
      remotePut = () => new Response('{}', { status: 500 }); // the switch did not turn on
      const assign = vi.fn();
      const real = window.location;
      Object.defineProperty(window, 'location', { configurable: true, value: { ...real, pathname: real.pathname, search: real.search, hash: real.hash, assign } });
      try {
        await mount(frag(FOLDER + '&setup=11111111-1111-4111-8111-aaaaaaaaaaaa'), { projectId: PROJ });
        await press();
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(puts()).toHaveLength(1);
        expect(assign).not.toHaveBeenCalled(); // held: no automatic move
        const card = container.querySelector('[data-testid=solo-phone-failed]')!;
        expect(card.textContent).toContain('폰으로 다루기를 켜지 못했어요 — 다시 켜 보거나, 폰 없이 대화부터 열어도 돼요.'); // Yuna 5121: this card has no «아래 카드», so not the recipe end card's line
        expect(card.textContent).not.toContain('아래 카드');
        expect(buttonOf('다시 켜기')).toBeTruthy(); expect(buttonOf('대화 열기')).toBeTruthy();
        if (how === 'again') {
          remotePut = () => new Response(JSON.stringify({ data: { enabled: true, can_change: true, enabled_at: 'now' } }), { status: 200 });
          await act(async () => { buttonOf('다시 켜기')!.click(); });
          for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
          expect(puts()).toHaveLength(2); // one more PUT
          expect(assign).toHaveBeenCalledTimes(1); // and then the conversation opens, as for a start that went well
          expect(String(assign.mock.calls[0][0])).toContain('/chats/c-1');
        } else {
          await act(async () => { buttonOf('대화 열기')!.click(); });
          expect(puts()).toHaveLength(1); // no PUT
          expect(assign).toHaveBeenCalledTimes(1);
          expect(String(assign.mock.calls[0][0])).toContain('/chats/c-1');
        }
      } finally { Object.defineProperty(window, 'location', { configurable: true, value: real }); }
      await act(async () => { root.render(<div />); });
      calls.length = 0; __resetOrgRemoteControlForTest();
    }
  });

  it('the switch turned on (or the tick left off) → the conversation opens at once, as before — no holding card', async () => {
    const SOLO = {
      setup_id: 's-1', device_name: 'Mac', state: 'handed_over', recipe_name: null, recipe: null, work_item_id: null, setup_kind: 'solo', conversation_id: 'c-1',
      members: [{ stage: null, role: null, member_id: 'm-1', kind: 'agent', runtime: 'claude', name: 'Claude Code' }],
      signals: { tools_connected: [], first_task_handed_at: null, first_result_at: null, workdir_fallback_at: null, blocked: null },
    };
    for (const untick of [false, true]) {
      statusNow = () => SOLO;
      remoteGet = remoteOf(OFF_OWNER);
      const assign = vi.fn();
      const real = window.location;
      Object.defineProperty(window, 'location', { configurable: true, value: { ...real, pathname: real.pathname, search: real.search, hash: real.hash, assign } });
      try {
        await mount(frag(FOLDER + '&setup=11111111-1111-4111-8111-aaaaaaaaaaaa'), { projectId: PROJ });
        if (untick) await act(async () => { tick()!.click(); });
        await press();
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(container.querySelector('[data-testid=solo-phone-failed]')).toBeNull();
        expect(assign).toHaveBeenCalledTimes(1);
      } finally { Object.defineProperty(window, 'location', { configurable: true, value: real }); }
      await act(async () => { root.render(<div />); });
      __resetOrgRemoteControlForTest();
    }
  });

  it('a new organization (no organization yet): the row is there, ticked, and the PUT goes to the organization the start made', async () => {
    confirmNow = () => new Response(JSON.stringify({ project_id: PROJ, org_id: 'o-new', conversation_id: 'c-1', members: [] }), { status: 200 });
    await mount(frag(FOLDER), { orgId: null });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(tick()?.checked).toBe(true);
    await press();
    expect(calls.some((c) => c.url.endsWith('/confirm-solo-new-org'))).toBe(true);
    expect(puts().map((p) => p.url)).toEqual([expect.stringContaining('/api/organizations/o-new/remote-control')]);
  });
});

describe('[SID:4711 AC2] after a solo start the first screen is the conversation', () => {
  const STATUS = (state: string, kind: string, room: string | null) => ({
    setup_id: 's-1', device_name: 'Mac', state, recipe_name: null, recipe: null, work_item_id: null, setup_kind: kind, conversation_id: room,
    members: [{ stage: null, role: null, member_id: 'm-1', kind: 'agent', runtime: 'claude', name: 'Claude Code' }],
    signals: { tools_connected: [], first_task_handed_at: null, first_result_at: null, workdir_fallback_at: null, blocked: null },
  });
  async function progress(status: unknown) {
    ctx.mockReturnValue({ projectId: PROJ, currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }], projectMemberships: [] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const assign = vi.fn();
    const real = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...real, pathname: real.pathname, search: real.search, hash: real.hash, assign } });
    try {
      await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SetupProgressView setupId="s-1" recipeName="" /></NextIntlClientProvider>); });
      // the first reading runs on the next task (setTimeout 0), then the fetch and the state change: let real tasks pass, no fixed wait
      for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    } finally { Object.defineProperty(window, 'location', { configurable: true, value: real }); }
    return assign;
  }
  it('handed over → the room opens, once', async () => {
    const assign = await progress(STATUS('handed_over', 'solo', 'c-1'));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0][0])).toContain('/chats/c-1');
  });
  it('not handed over yet → stays; a recipe or move setup is never sent anywhere', async () => {
    expect((await progress(STATUS('waiting_for_app', 'solo', 'c-1'))).mock.calls.length).toBe(0);
    await act(async () => { root.render(<div />); });
    expect((await progress(STATUS('handed_over', 'move', 'c-1'))).mock.calls.length).toBe(0);
  });
});

describe('[SID:4717] the solo card says the plan\'s agent room before «시작» (follow-up · PO 05:04Z)', () => {
  const room = (r: object | null) => () => new Response(JSON.stringify({ recipes: [], agent_room: r }), { status: 200 });
  const ORG_FOLDER = '&fshown=~/code/my-app&fname=my-app';
  const opts = { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Existing', orgId: 'o-1' }] };

  it('an organization with no room left → «시작» off before the press, the plan\'s limit, the team path, no confirm sent', async () => {
    recipesNow = room({ limit: 3, current: 3, available: 0, tier: 'free' });
    await mount(frag(ORG_FOLDER), opts);
    const box = container.querySelector('[data-testid=setup-room-short]')!;
    expect(box.textContent).toContain('지금은 에이전트를 더 만들 수 없어요. 무료 플랜은 에이전트를 3개까지 만들 수 있어요.');
    expect(container.querySelector('[data-testid=quick-room-use-team]')!.textContent).toBe('이미 있는 에이전트로 시작하려면 아래 «여러 에이전트로 팀 꾸리기»에서 골라요.');
    expect(linkOf('에이전트 정리하기')!.getAttribute('href')).toContain('/organization/workforce');
    expect(box.textContent).not.toContain('레시피');
    expect(buttonOf('만들기')!.disabled).toBe(true);
    await act(async () => { buttonOf('만들기')!.click(); });
    expect(calls.some((c) => c.url.includes('/confirm-solo'))).toBe(false);
  });

  it('codex self-QA: the room read lands AFTER the project question (402) → «넣고 시작» is held and the reason is said, never a silent press', async () => {
    ee.on = true;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    recipesNow = (() => gate.then(room({ limit: 3, current: 3, available: 0, tier: 'free' }))) as unknown as () => Response;
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project', limit: 1, existing_project: { id: PROJ, name: 'Mine' } } }), { status: 402 });
    await mount(frag(ORG_FOLDER), opts);
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid=quick-limit]')).not.toBeNull();
    expect(buttonOf('넣고 만들기')!.disabled).toBe(false);
    await act(async () => { open(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(buttonOf('넣고 만들기')!.disabled).toBe(true);
    expect(container.querySelector('[data-testid=quick-limit] [data-testid=setup-room-short]')).not.toBeNull();
    await act(async () => { buttonOf('넣고 만들기')!.click(); });
    expect(calls.filter((c) => c.url.endsWith('/confirm-solo')).length).toBe(1); // only the first press went out
  });

  it('room for one → the card as before (nothing said about the limit) and «시작» on', async () => {
    recipesNow = room({ limit: 3, current: 2, available: 1, tier: 'free' });
    await mount(frag(ORG_FOLDER), opts);
    expect(container.querySelector('[data-testid=setup-room-short]')).toBeNull();
    expect(buttonOf('만들기')!.disabled).toBe(false);
  });

  it('no limit (null) · a shape not read · the list failing → nothing said, nothing held', async () => {
    for (const answer of [room(null), room({ limit: 3, current: 3, available: 2 }), () => new Response('{}', { status: 500 })]) {
      recipesNow = answer;
      await mount(frag(ORG_FOLDER), opts);
      expect(container.querySelector('[data-testid=setup-room-short]')).toBeNull();
      expect(buttonOf('만들기')!.disabled).toBe(false);
      await act(async () => { root.unmount(); }); root = createRoot(container);
    }
  });

  it('a new organization and a member who is not an admin do not read it', async () => {
    await mount(frag(ORG_FOLDER), { orgId: null });
    await mount(frag(''), { role: 'member' });
    expect(calls.some((c) => c.url.endsWith('/api/desktop/recipes'))).toBe(false);
  });

  it('the 402 after the press (the room changed meanwhile) → the solo card\'s words: no «레시피», the plan\'s limit from the answer', async () => {
    ee.on = true;
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent', limit: 3, tier: 'free', current: 3, needed: 1, available: 0 } }), { status: 402 });
    await mount(frag(ORG_FOLDER), opts);
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const body = container.querySelector('[data-testid=setup-agent-limit-body]')!;
    expect(body.textContent).toBe('지금은 에이전트를 더 만들 수 없어요. 무료 플랜은 에이전트를 3개까지 만들 수 있어요. 계속하려면 요금제를 업그레이드해 주세요. 쓰지 않는 에이전트를 정리해 주세요.');
    expect(text()).toContain('업그레이드가 필요해요');
    expect(linkOf('요금제 업그레이드 →')).toBeTruthy();
    expect(text()).not.toContain('레시피');
  });
});

describe('[SID:4721] the member card on the first-setup page keeps the setup values through its reloads', () => {
  const memberReload = () => {
    const order: string[] = [];
    vi.stubGlobal('location', { ...window.location, pathname: '/desktop/setup', search: '', hash: '', reload: vi.fn(() => { order.push('reload'); }) } as unknown as Location);
    let replaced = '';
    vi.spyOn(window.history, 'replaceState').mockImplementation((_s, _t, url) => { replaced = String(url); order.push('replace'); });
    return { order, replaced: () => replaced };
  };
  // the values go back into the fragment — a bare reload showed «데스크톱 앱에서 열어 주세요» — ALL of them (code · setup · runtimes · caps · versions · folder)
  const checkFragment = (replaced: string, sent: string = frag('')) => {
    expect(replaced.startsWith('/desktop/setup#')).toBe(true);
    expect(parseSetupFragment('#' + replaced.split('#')[1])).toEqual(parseSetupFragment(sent));
  };

  it('[다시 확인] reloads WITH the setup values', async () => {
    const r = memberReload();
    await mount(frag(''), { role: 'member' });
    await act(async () => { buttonOf('다시 확인')!.click(); });
    expect(r.order).toEqual(['replace', 'reload']);
    checkFragment(r.replaced());
  });

  it('the server refuses [시작] as not-admin (the page thought they were an admin): the same card, and [다시 확인] reloads WITH the setup values', async () => {
    const r = memberReload();
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'not_org_admin' } }), { status: 403 });
    await mount(frag('&fshown=~/new/folder&fname=folder'), { role: 'owner' });
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('에이전트를 만들려면 조직 관리자여야 해요');
    await act(async () => { buttonOf('다시 확인')!.click(); });
    expect(r.order).toEqual(['replace', 'reload']);
    checkFragment(r.replaced(), frag('&fshown=~/new/folder&fname=folder'));
  });

  it('create → switch → the reload carries the setup values too (the same page as the new owner, not «앱에서 열기»)', async () => {
    const r = memberReload();
    await mount(frag(''), { role: 'member' });
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    const form = document.body.querySelector('form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.filter((c) => c.url === '/api/organizations' || c.url === '/api/switch-org').map((c) => [c.url, c.body])).toEqual([
      ['/api/organizations', { name: '김지우의 조직' }],
      ['/api/switch-org', { org_id: 'o-mine' }],
    ]);
    expect(r.order).toEqual(['replace', 'reload']);
    checkFragment(r.replaced());
  });

  it('the organization was made but the switch failed: [다시 확인] tries the SWITCH again too (a bare reload would drop the made organization and close the primary)', async () => {
    const r = memberReload();
    await mount(frag(''), { role: 'member' });
    const base = globalThis.fetch;
    let switches = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === '/api/switch-org'
      ? (calls.push({ url: '/api/switch-org' }), ++switches === 1 ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }))
      : base(input, init)));
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    const form = document.body.querySelector('form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('조직을 전환하지 못했어요');
    expect(r.order).toEqual([]);
    await act(async () => { buttonOf('다시 확인')!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.filter((c) => c.url === '/api/organizations')).toHaveLength(1); // never a second organization
    expect(calls.filter((c) => c.url === '/api/switch-org')).toHaveLength(2);
    expect(r.order).toEqual(['replace', 'reload']);
  });

  it('a second press while the switch is on its way does not send a second switch', async () => {
    const r = memberReload();
    await mount(frag(''), { role: 'member' });
    let release: (v: Response) => void = () => {};
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === '/api/switch-org'
      ? (calls.push({ url: '/api/switch-org' }), new Promise<Response>((res) => { release = res; }))
      : base(input, init)));
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    const form = document.body.querySelector('form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    expect(buttonOf('내 조직 만들어 시작하기')!.disabled).toBe(true);
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    expect(calls.filter((c) => c.url === '/api/switch-org')).toHaveLength(1);
    await act(async () => { release(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(r.order).toEqual(['replace', 'reload']);
  });

  it('en: the dialog opens with «Jiwoo\'s organization» and the address box stays empty (no derived address such as «jiwoo-s-organization» is sent)', async () => {
    memberReload();
    ctx.mockReturnValue({ projectId: undefined, currentProjectSlug: 'proj', userName: 'Jiwoo', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'member' }], projectMemberships: [] });
    const query = parseSetupFragment(frag(''))!;
    await act(async () => { root.render(<NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul"><DesktopSetupQuick query={query} onTeam={() => {}} /></NextIntlClientProvider>); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonOf('Create my own organization')!.click(); });
    expect((document.body.querySelector('#org-name') as HTMLInputElement).value).toBe("Jiwoo's organization");
    expect((document.body.querySelector('#org-slug') as HTMLInputElement).value).toBe('');
    const form = document.body.querySelector('form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.find((c) => c.url === '/api/organizations')!.body).toEqual({ name: "Jiwoo's organization" });
  });
});

describe('[SID:4713 AC2] the card picks the program a folder\'s CLAUDE.md / AGENTS.md means, and says so once', () => {
  const checked = () => container.querySelector('input[name=quick-runtime]:checked')!.parentElement!.textContent ?? '';
  const line = () => container.querySelector('[data-testid=quick-trace]')?.textContent ?? null;
  const F = '&fshown=~/code/my-app&fname=my-app';

  it('a folder with CLAUDE.md → Claude Code picked and the line names the file; with AGENTS.md → Codex picked, the line names AGENTS.md, and [시작] sends codex', async () => {
    await mount(frag(`${F}&pick=codex&ftrace=CLAUDE.md`)); // the earlier pick is only an echo: the folder's mark wins over it
    expect(checked()).toContain('Claude Code');
    expect(line()).toBe('이 폴더에 CLAUDE.md가 있어요 · 도구는 Claude Code로 골라 뒀어요');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount(frag(`${F}&ftrace=AGENTS.md`));
    expect(checked()).toContain('Codex');
    expect(line()).toBe('이 폴더에 AGENTS.md가 있어요 · 도구는 Codex로 골라 뒀어요');
    await act(async () => { buttonOf('만들기')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.find((c) => c.url.endsWith('/confirm-solo'))!.body).toEqual({ code: CODE, runtime: 'codex', project_name: 'my-app', agent_name: 'Codex', folder_name: 'my-app' });
  });

  it('both marks → the first program this computer has in the found order; no mark → no line and the usual default', async () => {
    await mount(frag(`${F}&ftrace=CLAUDE.md,AGENTS.md`));
    expect(checked()).toContain('Claude Code');
    expect(line()).toContain('CLAUDE.md');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount(frag(`${F}&pick=codex`));
    expect(checked()).toContain('Codex'); // the echoed pick stands when the folder says nothing
    expect(line()).toBeNull();
  });

  it('a mark whose program this computer does not have → the usual default and NO line (never a word about something that was not done)', async () => {
    await mount(`#code=${CODE}&setup=11111111-1111-4111-8111-aaaaaaaaaaaa&runtimes=claude&caps=move,solo&rv=claude:2.1.289${F}&ftrace=AGENTS.md`);
    expect(line()).toBeNull();
    expect(text()).toContain('Claude Code');
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toContain('이름 Claude Code · 도구 Claude Code');
  });

  it('the person picks the other radio → the line is gone (it would be false); picking the marked one again brings it back', async () => {
    await mount(frag(`${F}&ftrace=AGENTS.md`));
    const radios = () => [...container.querySelectorAll<HTMLInputElement>('input[name=quick-runtime]')];
    await act(async () => { radios().find((r) => r.parentElement!.textContent!.includes('Claude Code'))!.click(); });
    expect(checked()).toContain('Claude Code');
    expect(line()).toBeNull();
    await act(async () => { radios().find((r) => r.parentElement!.textContent!.includes('Codex'))!.click(); });
    expect(line()).toContain('AGENTS.md');
  });

  it('the person\'s radio choice belongs to the folder it was made for: a folder picked afterwards starts from its own mark again', async () => {
    const query = (extra: string) => parseSetupFragment(frag(extra))!;
    ctx.mockReturnValue({ projectId: undefined, currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }], projectMemberships: [] });
    const render = async (extra: string) => { await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopSetupQuick query={query(extra)} onTeam={() => undefined} /></NextIntlClientProvider>); }); for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
    await render(`${F}&ftrace=AGENTS.md`);
    await act(async () => { [...container.querySelectorAll<HTMLInputElement>('input[name=quick-runtime]')].find((r) => r.parentElement!.textContent!.includes('Claude Code'))!.click(); });
    expect(checked()).toContain('Claude Code');
    await render('&fshown=~/code/other&fname=other&ftrace=AGENTS.md'); // another folder, same page
    expect(checked()).toContain('Codex');
    expect(line()).toContain('AGENTS.md');
  });

  // story 4713 (Yuna 10-17): Codex was picked by AGENTS.md in folder A; the next folder (no mark) kept it, because the folder window got the SHOWN program back as `pick=`.
  const pickOf = (label: string) => new URL((linkOf(label)!.getAttribute('href') as string).replace('ai.sprintable:', 'https://x')).searchParams.get('pick');

  it('a program a folder\'s mark picked is NOT sent back to the folder window: the next folder (no mark) starts from the usual default again', async () => {
    const query = (extra: string) => parseSetupFragment(frag(extra))!;
    ctx.mockReturnValue({ projectId: undefined, currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }], projectMemberships: [] });
    const render = async (extra: string) => { await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopSetupQuick query={query(extra)} onTeam={() => undefined} /></NextIntlClientProvider>); }); for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
    await render(`${F}&ftrace=AGENTS.md`);
    expect(checked()).toContain('Codex'); // the mark picked it
    expect(pickOf('바꾸기')).toBe('claude'); // …but what the folder window gets back is the default, not the mark's pick
    // the app opens the next folder's address with the echo it was given
    await render(`&fshown=~/code/other&fname=other&pick=${pickOf('바꾸기')}`);
    expect(checked()).toContain('Claude Code');
    expect(line()).toBeNull();
  });

  it('the person\'s OWN radio choice is sent back and stays for the next folder (no mark there)', async () => {
    const query = (extra: string) => parseSetupFragment(frag(extra))!;
    ctx.mockReturnValue({ projectId: undefined, currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }], projectMemberships: [] });
    const render = async (extra: string) => { await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopSetupQuick query={query(extra)} onTeam={() => undefined} /></NextIntlClientProvider>); }); for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
    await render(F); // a folder with no mark: Claude Code by default
    await act(async () => { [...container.querySelectorAll<HTMLInputElement>('input[name=quick-runtime]')].find((r) => r.parentElement!.textContent!.includes('Codex'))!.click(); });
    expect(checked()).toContain('Codex');
    expect(pickOf('바꾸기')).toBe('codex'); // the person's choice goes to the folder window
    await render(`&fshown=~/code/other&fname=other&pick=${pickOf('바꾸기')}`);
    expect(checked()).toContain('Codex'); // …and is still there in the next folder
    expect(line()).toBeNull();
  });

  it('pressing the radio a folder\'s mark already picked is the person\'s own choice too: it goes to the folder window and stays for the next folder (codex 01a151a1)', async () => {
    const query = (extra: string) => parseSetupFragment(frag(extra))!;
    ctx.mockReturnValue({ projectId: undefined, currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }], projectMemberships: [] });
    const render = async (extra: string) => { await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopSetupQuick query={query(extra)} onTeam={() => undefined} /></NextIntlClientProvider>); }); for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
    await render(`${F}&ftrace=AGENTS.md`);
    expect(checked()).toContain('Codex'); // the mark picked it
    expect(pickOf('바꾸기')).toBe('claude'); // not the person's choice yet
    await act(async () => { [...container.querySelectorAll<HTMLInputElement>('input[name=quick-runtime]')].find((r) => r.parentElement!.textContent!.includes('Codex'))!.click(); }); // already checked: no change event, still a choice
    expect(pickOf('바꾸기')).toBe('codex');
    await render(`&fshown=~/code/other&fname=other&pick=${pickOf('바꾸기')}`);
    expect(checked()).toContain('Codex');
    expect(line()).toBeNull();
  });

  it('a person\'s choice that went to the folder window beats nothing but never a mark: the next folder WITH a mark still follows its mark', async () => {
    await mount(frag(`${F}&pick=claude&ftrace=AGENTS.md`));
    expect(checked()).toContain('Codex');
    expect(line()).toContain('AGENTS.md');
  });

  it('English words', async () => {
    await mount(frag(`${F}&ftrace=AGENTS.md`), {}, 'en');
    expect(line()).toBe('This folder has AGENTS.md · Codex is picked for it');
  });
});

describe('[SID:4784] the card is the moment an agent is made — «에이전트 만들기»', () => {
  const F4784 = '&fshown=~/code/my-app&fname=my-app';
  const posts = () => calls.filter((c) => c.url.endsWith('/confirm-solo'));
  const nameField = () => container.querySelector('[data-testid=quick-agent-name]') as HTMLInputElement;
  const roleField = () => container.querySelector('[data-testid=quick-agent-role]') as HTMLInputElement;
  const typeInto = async (el: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

  it('says what is made, shows tool · name · role · folder, and sends NOTHING until «만들기» is pressed', async () => {
    await mount(frag(F4784), { projectId: PROJ });
    expect(container.querySelector('h1')!.textContent).toBe('에이전트 만들기');
    expect(nameField().value).toBe('Claude Code'); // the tool's name is the default
    expect(roleField().value).toBe('');
    expect(container.querySelector('[data-testid=quick-role-hint]')!.textContent).toBe('이름 옆에 보이는 이름표예요 · 에이전트가 일하는 방식은 바뀌지 않아요'); // a label, not a persona (PO 08:48Z · Yuna: «팀 목록» is not a product word)
    expect(text()).toContain('① 도구');
    expect(text()).toContain('② 이름과 역할');
    expect(text()).toContain('③ 폴더');
    expect(container.querySelector('[data-testid=quick-create-nothing]')!.textContent).toBe('누르기 전에는 에이전트가 만들어지지 않아요');
    expect(buttonOf('시작')).toBeUndefined(); // no «시작» that makes an agent without saying so
    expect(posts()).toHaveLength(0);
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it('the name follows the tool until the person types one; what they typed and the role go to the server as they stand (trimmed)', async () => {
    await mount(frag(F4784), { projectId: PROJ });
    await act(async () => { (container.querySelector('input[name=quick-runtime][type=radio]:not(:checked)') as HTMLInputElement).click(); });
    expect(nameField().value).toBe('Codex');
    await typeInto(nameField(), '  Reviewer ');
    await typeInto(roleField(), ' 코드 리뷰어 ');
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toContain('이름 Reviewer · 도구 Codex'); // the line follows what is typed
    await act(async () => { (container.querySelector('input[name=quick-runtime]:not(:checked)') as HTMLInputElement).click(); });
    expect(nameField().value).toBe('  Reviewer '); // a typed name stays when the tool changes
    await act(async () => { buttonOf('만들기')!.click(); });
    await settle();
    expect(posts().map((p) => p.body)).toEqual([{ code: CODE, runtime: 'claude', project_name: 'my-app', agent_name: 'Reviewer', agent_role: '코드 리뷰어', folder_name: 'my-app' }]);
  });

  it('a blank name holds «만들기» with its reason in view, and sends nothing', async () => {
    await mount(frag(F4784), { projectId: PROJ });
    await typeInto(nameField(), '   ');
    expect(buttonOf('만들기')!.disabled).toBe(true);
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toBe('이름을 적으면 만들 수 있어요');
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(posts()).toHaveLength(0);
  });

  it('a name an agent already has: the free name goes into the field, the line says so, nothing was made — and the next press sends that name', async () => {
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'agent_name_taken', message: 'x', suggested_name: 'Helper 2' } }), { status: 409 });
    await mount(frag(F4784), { projectId: PROJ });
    await typeInto(nameField(), 'Helper');
    await act(async () => { buttonOf('만들기')!.click(); });
    await settle();
    expect(nameField().value).toBe('Helper 2');
    expect(document.activeElement).toBe(nameField()); // the line sits under the button; the cursor goes to the field it is about (Yuna)
    expect(container.querySelector('[data-testid=quick-error]')!.textContent).toBe('이미 있는 이름이에요 · 쓸 수 있는 이름을 칸에 넣어 뒀어요: Helper 2 — 괜찮으면 «만들기»를 다시 눌러 주세요');
    expect(buttonOf('만들기')!.disabled).toBe(false); // the card is still the card: nothing started, nothing redirected
    confirmNow = () => new Response(JSON.stringify({ project_id: PROJ, conversation_id: 'c-1', members: [] }), { status: 200 });
    await act(async () => { buttonOf('만들기')!.click(); });
    await settle();
    expect(posts().map((p) => (p.body as { agent_name: string }).agent_name)).toEqual(['Helper', 'Helper 2']);
  });

  it('the free plan\'s «넣고 만들기» question holds its button while the name is blank, with the reason, and sends nothing', async () => {
    ee.on = true;
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project', limit: 1, existing_project: { id: PROJ, name: 'Mine' } } }), { status: 402 });
    await mount(frag('&fshown=~/new/folder&fname=folder'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Mine', orgId: 'o-1' }] });
    await act(async () => { buttonOf('만들기')!.click(); });
    await settle();
    expect(buttonOf('넣고 만들기')!.disabled).toBe(false);
    await typeInto(nameField(), ' ');
    expect(buttonOf('넣고 만들기')!.disabled).toBe(true);
    expect(container.querySelector('[data-testid=quick-limit-name-blank]')!.textContent).toBe('이름을 적으면 만들 수 있어요');
    expect(posts()).toHaveLength(1); // only the first press went out
  });

  it('two setups (tabs) keep their own drafts: typing in one never overwrites the other\'s', async () => {
    const other = frag(F4784).replace('11111111-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-4111-8111-bbbbbbbbbbbb');
    await mount(frag(F4784), { projectId: PROJ });
    await typeInto(nameField(), 'First');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount(other, { projectId: PROJ });
    await typeInto(nameField(), 'Second');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount(frag(F4784), { projectId: PROJ });
    expect(nameField().value).toBe('First');
  });

  it('a failed creation says «만들지 못했어요» (not «시작»), keeps the typed fields and the button', async () => {
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'whatever' } }), { status: 500 });
    await mount(frag(F4784), { projectId: PROJ });
    await typeInto(roleField(), '리뷰어');
    await act(async () => { buttonOf('만들기')!.click(); });
    await settle();
    expect(container.querySelector('[data-testid=quick-error]')!.textContent).toBe('만들지 못했어요 — 다시 시도해 주세요');
    expect(roleField().value).toBe('리뷰어');
    expect(buttonOf('만들기')!.disabled).toBe(false);
  });

  it('the folder window reloads the page: what was typed waits in the tab for this setup and comes back; another setup starts clean', async () => {
    await mount(frag(F4784), { projectId: PROJ });
    await typeInto(nameField(), 'Reviewer');
    await typeInto(roleField(), '리뷰어');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount(frag(F4784), { projectId: PROJ });
    expect(nameField().value).toBe('Reviewer');
    expect(roleField().value).toBe('리뷰어');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount(frag(F4784).replace('11111111-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-4111-8111-bbbbbbbbbbbb'), { projectId: PROJ });
    expect(nameField().value).toBe('Claude Code');
    expect(roleField().value).toBe('');
  });

  it('a new organization: the new-org confirmation carries the name and role as well', async () => {
    await mount(frag(F4784), { orgId: null });
    await typeInto(nameField(), 'Builder');
    await act(async () => { buttonOf('만들기')!.click(); });
    await settle();
    const post = calls.find((c) => c.url.endsWith('/confirm-solo-new-org'))!;
    expect(post.body).toMatchObject({ runtime: 'claude', project_name: 'my-app', agent_name: 'Builder', folder_name: 'my-app' });
  });

  it('English words', async () => {
    await mount(frag(F4784), { projectId: PROJ }, 'en');
    expect(container.querySelector('h1')!.textContent).toBe('Create an agent');
    expect(text()).toContain('② Name and role');
    expect(buttonOf('Create')).toBeDefined();
    expect(container.querySelector('[data-testid=quick-create-nothing]')!.textContent).toBe('No agent is created until you press it');
  });
});
