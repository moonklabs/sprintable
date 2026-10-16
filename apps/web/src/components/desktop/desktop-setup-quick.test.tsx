// @vitest-environment jsdom
//
// story 4711 — 처음 셋업 세 걸음(에이전트 → 폴더 → 시작): one card · the folder comes back from the app's Mac window in the `#` ·
// [시작] = one confirm-solo with the runtime and the folder's NAME (never a path) · the free plan's one project asks instead of 402.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    if (/\/api\/organizations\/[^/]+\/remote-control$/.test(url)) return init?.method === 'PUT' ? remotePut() : remoteGet();
    if (url.endsWith('/api/invites/mine')) return new Response(JSON.stringify({ invites: [] }), { status: 200 });
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
  statusNow = () => ({}); __resetOrgRemoteControlForTest(); teamPressed = false; ee.on = false; sp.value = null; remoteGet = remoteOf({ enabled: true, can_change: true, enabled_at: 'now' }); remotePut = () => new Response(JSON.stringify({ data: { enabled: true, can_change: true, enabled_at: 'now' } }), { status: 200 }); stub();
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('[SID:4711] the first setup in three steps', () => {
  it('opens with the program picked, the folder button, and [시작] off with its reason in view', async () => {
    await mount(frag(''), { projects: [] });
    expect(text()).toContain('이 컴퓨터에서 에이전트 시작하기');
    expect((container.querySelector('input[name=quick-runtime]:checked')!.parentElement)!.textContent).toContain('Claude Code');
    expect(text()).toContain('2.1.289'); // the version after the name
    expect(linkOf('폴더 고르기')!.getAttribute('href')).toBe('ai.sprintable:/desktop/setup?intent=folder&pick=claude');
    expect(buttonOf('시작')!.disabled).toBe(true);
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toBe('폴더를 고르면 시작할 수 있어요'); // a line, not a tooltip
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
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toBe('Claude Code 에이전트 하나를 만들어 my-app 프로젝트에 넣고, 이 폴더에서 대화를 열어요');
    expect(buttonOf('시작')!.disabled).toBe(false);
    await act(async () => { buttonOf('시작')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const post = calls.find((c) => c.url.endsWith('/confirm-solo'))!;
    expect(post.body).toEqual({ code: CODE, runtime: 'claude', project_name: 'my-app' }); // no path, no workdir
    expect(JSON.stringify(calls)).not.toContain('~/code');
  });

  it('codex self-QA: two presses of [시작] before the screen redraws send ONE confirmation', async () => {
    await mount(frag('&fshown=~/code/my-app&fname=my-app'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Existing', orgId: 'o-1' }] });
    const go = buttonOf('시작')!;
    await act(async () => { go.click(); go.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.filter((c) => c.url.endsWith('/confirm-solo')).length).toBe(1);
  });

  it('codex self-QA: a folder name that is a path (a made-up link) is no answer — nothing is sent, the button asks for the folder', async () => {
    for (const name of ['/Users/me/repo', 'a/b', 'a\\b']) {
      await mount(frag(`&fshown=~/code/my-app&fname=${encodeURIComponent(name)}`), { projectId: PROJ, projects: [] });
      expect(container.querySelector('[data-testid=quick-folder]')).toBeNull();
      expect(buttonOf('시작')!.disabled).toBe(true);
      expect(calls.filter((c) => c.url.includes('confirm-solo'))).toEqual([]);
      await act(async () => { root.render(<div />); });
    }
  });

  it('a project the app found for this folder is used (by id), and the line says so', async () => {
    await mount(frag(`&fshown=~/code/my-app&fname=my-app&fproject=${PROJ}`), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Existing', orgId: 'o-1' }] });
    expect(container.querySelector('[data-testid=quick-project]')!.textContent).toBe('이 폴더의 프로젝트 · Existing');
    await act(async () => { buttonOf('시작')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.find((c) => c.url.endsWith('/confirm-solo'))!.body).toEqual({ code: CODE, runtime: 'claude', project_id: PROJ });
  });

  it('a project id this organization does not have is not sent — a new project by the folder\'s name (the server would 404 it)', async () => {
    await mount(frag(`&fshown=~/code/my-app&fname=my-app&fproject=${PROJ}`), { projectId: PROJ, projects: [] });
    await act(async () => { buttonOf('시작')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.find((c) => c.url.endsWith('/confirm-solo'))!.body).toEqual({ code: CODE, runtime: 'claude', project_name: 'my-app' });
  });

  it('a project name this organization has shows as «{name} 2» (the server makes the final one by the same rule)', async () => {
    await mount(frag('&fshown=~/a/app&fname=app'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'App', orgId: 'o-1' }] });
    expect(container.querySelector('[data-testid=quick-project]')!.textContent).toBe('프로젝트 이름 · app 2');
  });

  it('the home folder or the top of the disk asks once and holds [시작] until «맞아요»', async () => {
    await mount(frag('&fshown=~&fname=yoonjae&fwide=1'));
    expect(container.querySelector('[data-testid=quick-wide]')!.textContent).toContain('이 폴더 전체에서 일해요 — 맞나요?');
    expect(buttonOf('시작')!.disabled).toBe(true);
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toBe('폴더를 확인하면 시작할 수 있어요');
    await act(async () => { buttonOf('맞아요')!.click(); });
    expect(buttonOf('시작')!.disabled).toBe(false);
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
    expect(text()).toContain('Start an agent on this computer');
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toBe('Creates one Claude Code agent, adds it to the my-app project, and opens a conversation in this folder');
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
    expect(buttonOf('시작')).toBeUndefined();
  });

  it('a person who is not an owner/admin sees the not-admin card, not the form', async () => {
    await mount(frag(''), { role: 'member' });
    expect(text()).not.toContain('이 컴퓨터에서 에이전트 시작하기');
  });

  it('the free plan\'s one project: the 402 names it, the card asks, and «넣고 시작» sends THAT project — nothing was put there before', async () => {
    ee.on = true;
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project', limit: 1, existing_project: { id: PROJ, name: 'Mine' } } }), { status: 402 });
    await mount(frag('&fshown=~/new/folder&fname=folder'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Mine', orgId: 'o-1' }] });
    await act(async () => { buttonOf('시작')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const ask = container.querySelector('[data-testid=quick-limit]')!;
    expect(ask.textContent).toContain('무료 플랜은 프로젝트가 하나예요');
    expect(ask.textContent).toContain('이 폴더의 에이전트를 Mine 프로젝트에 넣어 시작할 수 있어요 — 에이전트는 이 폴더에서 일해요.');
    expect(ask.textContent).toContain('요금제 업그레이드 →'); // billing open
    expect(container.querySelector('[data-testid=quick-project]')!.textContent).toBe('프로젝트 · Mine');
    expect(buttonOf('시작')).toBeUndefined(); // Yuna 5121 ①: the one primary on the card is «넣고 시작» — no [시작] beside it
    expect(container.querySelector('[data-testid=quick-start-line]')).toBeNull();
    confirmNow = () => new Response(JSON.stringify({ project_id: PROJ, conversation_id: 'c-1', members: [] }), { status: 200 });
    await act(async () => { buttonOf('넣고 시작')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const posts = calls.filter((c) => c.url.endsWith('/confirm-solo'));
    expect(posts.map((p) => p.body)).toEqual([{ code: CODE, runtime: 'claude', project_name: 'folder' }, { code: CODE, runtime: 'claude', project_id: PROJ }]);
  });

  it('billing closed (prod today): the free-plan question has no upgrade link', async () => {
    ee.on = false;
    confirmNow = () => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project', limit: 1, existing_project: { id: PROJ, name: 'Mine' } } }), { status: 402 });
    await mount(frag('&fshown=~/new/folder&fname=folder'), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'Mine', orgId: 'o-1' }] });
    await act(async () => { buttonOf('시작')!.click(); });
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
    for (const [caps, want] of [['caps=move,solo', '이 컴퓨터에서 에이전트 시작하기'], ['caps=move', '이 컴퓨터에 에이전트를 만들어']] as const) {
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
  const press = async () => { await act(async () => { buttonOf('시작')!.click(); }); for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

  it('an owner of an organization whose remote control is OFF: one tick above [시작], ticked, with the words — and it sits in the start row (no new step)', async () => {
    remoteGet = remoteOf(OFF_OWNER);
    await mount(frag(FOLDER), { projectId: PROJ, projects: [{ projectId: PROJ, projectName: 'P', orgId: 'o-1' }] });
    expect(tick()?.checked).toBe(true);
    expect(container.querySelector('[data-testid=setup-phone-control]')!.textContent).toContain('폰으로도 에이전트 다루기');
    expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(1);
    const row = container.querySelector('[data-testid=setup-phone-control]')!;
    expect(row.nextElementSibling?.querySelector('button')?.textContent).toBe('시작'); // just above «시작»
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
