// @vitest-environment jsdom
//
// story #4576 — «이미 있는 에이전트 옮기기» (Yuna «4576 셋업 첫 고르기» · doc b0713c54): the two ways on the setup page, the move
// list, its confirm (no recipe · device and keys only), its refusals and its two-step progress.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { ctx } = vi.hoisted(() => ({ ctx: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx() }));

import { DesktopSetup } from './desktop-setup';
import { SetupProgressView } from './desktop-setup-progress';
import { moveConfirmBody, moveListOrder, moveProgress, parseSetupQuery, setupFragment, parseSetupFragment, NOT_CONNECTED_AFTER_HANDOVER_MS, type AttachableAgent, type SetupStatus } from '@/lib/desktop-setup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const RECIPES = [{ id: 'rec-1', key: 'org.research_one', name: '조사 한 명', roles: [{ role: '조사', kind: 'agent', stages: ['research'] }] }];
const DAN: AttachableAgent = { id: 'a-dan', name: '댄 어윈', runtime: 'claude', live_keys: 1, last_used_at: null, in_project: true };
const KADIR: AttachableAgent = { id: 'a-kadir', name: '까디르 QA', runtime: 'codex', live_keys: 0, last_used_at: null, in_project: true };
const DAMRONG: AttachableAgent = { id: 'a-dam', name: '담롱', runtime: 'claude', live_keys: 0, last_used_at: null, in_project: false };

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; method?: string; body?: unknown }[];
let agentsNow: () => Response;
let statusNow: () => unknown = () => ({});

function stub(confirm: () => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/api/desktop/recipes')) return new Response(JSON.stringify({ recipes: RECIPES }), { status: 200 });
    if (url.includes('/api/desktop/setup/agents')) return agentsNow();
    if (url.includes('/api/desktop/setup-codes/')) return confirm();
    if (url.includes('/api/desktop/setups/')) return new Response(JSON.stringify(statusNow()), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
}
async function mount(node: React.ReactNode, locale: 'ko' | 'en' = 'ko') {
  ctx.mockReturnValue({ projectId: 'p-1', currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }] });
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const text = () => container.textContent ?? '';
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const chooseMove = async () => { await act(async () => { (container.querySelector('input[name=setup-kind][value=move]') as HTMLInputElement).click(); }); };
const rows = () => [...container.querySelectorAll('[data-testid=setup-move-row]')] as HTMLElement[];
const tick = async (name: string) => {
  const row = rows().find((r) => r.textContent?.includes(name))!;
  await act(async () => { (row.querySelector('input[type=checkbox]') as HTMLInputElement).click(); });
};
const startRowLine = () => (container.querySelector('[data-testid=setup-start-row] p') as HTMLElement).textContent;

beforeEach(() => {
  agentsNow = () => new Response(JSON.stringify({ agents: [DAMRONG, DAN, KADIR] }), { status: 200 });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('[SID:4576] the two ways · the move list', () => {
  it('no agent the organization could move → no «시작 방법» at all (the page as before)', async () => {
    agentsNow = () => new Response(JSON.stringify({ agents: [] }), { status: 200 });
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    expect(container.querySelector('[data-testid=setup-kind]')).toBeNull();
    expect(text()).toContain('조사 한 명');
    expect(button('시작')).toBeDefined();
  });

  it('agents to move + an app that can → «레시피로 시작» chosen by default; «옮기기» hides recipe · roles · folder and lists the agents, movable first, none ticked', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    const kinds = container.querySelector('[data-testid=setup-kind]') as HTMLElement;
    expect(kinds.textContent).toContain('시작 방법');
    expect(kinds.textContent).toContain('레시피로 시작레시피의 역할을 에이전트에게 맡기고 첫 일감으로 바로 시작해요');
    expect(kinds.textContent).toContain('이미 있는 에이전트 옮기기이 조직에서 일하던 에이전트를 이 컴퓨터로 옮겨요');
    expect((container.querySelector('input[name=setup-kind][value=recipe]') as HTMLInputElement).checked).toBe(true);
    // the recipe way's head line stays as it was
    expect(text()).toContain('레시피를 고르면 이 컴퓨터의 에이전트가 역할을 맡아 바로 첫 일감을 시작해요.');
    await chooseMove();
    expect(text()).toContain('옮길 에이전트를 고르면 이 컴퓨터의 앱이 받아 가요 — 맡은 역할 · 일감 · 프로젝트 설정은 그대로이고, 첫 일감은 따로 만들지 않아요.');
    expect(container.querySelector('[data-testid=setup-recipe-chosen]')).toBeNull();
    expect(container.querySelector('#setup-roles')).toBeNull();
    expect(container.querySelector('#setup-folder')).toBeNull();
    expect(text()).toContain('이 컴퓨터에서 찾은 에이전트: Claude Code · Codex');
    expect(rows().map((r) => [r.querySelector('.font-medium')!.textContent, r.dataset.state])).toEqual([['댄 어윈', 'ok'], ['까디르 QA', 'ok'], ['담롱', 'not-in-project']]);
    expect(rows()[0].textContent).toContain('Claude Code · 이 컴퓨터에 있음');
    expect(rows()[2].textContent).toContain('이 프로젝트에 아직 없어요 — 먼저 프로젝트에 추가해 주세요');
    expect((rows()[2].querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect(rows().every((r) => !(r.querySelector('input') as HTMLInputElement).checked)).toBe(true);
    expect(text()).toContain('작업 폴더는 옮긴 뒤 앱에서 에이전트마다 골라요 — 이 컴퓨터에서 일한 적이 있는 에이전트는 그 폴더를 그대로 써요');
    expect(button('옮기기')!.disabled).toBe(true);
    expect(startRowLine()).toBe('옮길 에이전트를 하나 이상 골라 주세요');
    expect(button('시작')).toBeUndefined();
  });

  it('only rows that cannot move → the start line says none can be moved (each row keeps its why)', async () => {
    agentsNow = () => new Response(JSON.stringify({ agents: [DAMRONG] }), { status: 200 });
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    await chooseMove();
    expect(container.querySelector('[data-testid=setup-move-empty]')).toBeNull();
    expect(startRowLine()).toBe('옮길 수 있는 에이전트가 없어요');
    expect(button('옮기기')!.disabled).toBe(true);
    expect(text()).not.toContain('작업 폴더는 옮긴 뒤');
  });

  it('a runtime not found here → that row off with why («{runtime}이 이 컴퓨터에 없어요»)', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} canMove />);
    await chooseMove();
    const kadir = rows().find((r) => r.textContent?.includes('까디르 QA'))!;
    expect(kadir.dataset.state).toBe('runtime-missing');
    expect(kadir.textContent).toContain('Codex가 이 컴퓨터에 없어요');
    expect((kadir.querySelector('input') as HTMLInputElement).disabled).toBe(true);
  });

  it('a tick shows the 4565 note under it (live key only) · [옮기기] = one confirm with no recipe, no folder, only the ticked agents', async () => {
    stub(() => new Response(JSON.stringify({ setup_id: 's-1', work_item_id: null, members: [] }), { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove setupId="s-1" />);
    await chooseMove();
    expect(container.querySelector('[data-testid=setup-moved-note]')).toBeNull(); // nothing said before a tick
    await tick('댄 어윈');
    expect(container.querySelector('[data-testid=setup-moved-note]')?.textContent).toContain('이 컴퓨터의 앱이 받아 가면 이 에이전트의 지금 연결이 끊겨요');
    await tick('까디르 QA'); // no live key → no note for it
    expect(container.querySelectorAll('[data-testid=setup-moved-note]')).toHaveLength(1);
    expect(startRowLine()).toBe('에이전트 2개를 이 컴퓨터로 옮겨요');
    calls = [];
    await act(async () => { button('옮기기')!.click(); });
    await settle();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain('/api/desktop/setup-codes/confirm');
    expect(posts[0].body).toEqual({ code: CODE, project_id: 'p-1', roles: [{ role: 'move', agent_id: 'a-dan' }, { role: 'move', agent_id: 'a-kadir' }] });
  });

  it('an app that cannot move (no `caps=move`) → the way shows, turned off, with why and what to do', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} />);
    const move = container.querySelector('[data-testid=setup-kind-move]') as HTMLElement;
    expect((move.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect(container.querySelector('[data-testid=setup-kind-move-why]')?.textContent).toBe('이 앱 판에서는 옮길 수 없어요 — 앱을 업데이트해 주세요');
    expect(move.textContent).not.toContain('이 조직에서 일하던 에이전트를 이 컴퓨터로 옮겨요');
    // a click on it changes nothing: still the recipe way, no move list, «시작»
    await act(async () => { (move.querySelector('input') as HTMLInputElement).click(); (move as HTMLElement).click(); });
    expect(container.querySelector('[data-testid=setup-move-list]')).toBeNull();
    expect(button('시작')).toBeDefined();
    expect(button('옮기기')).toBeUndefined();
  });

  it('en: the ways and the start line', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />, 'en');
    expect(text()).toContain('How to start');
    await chooseMove();
    await tick('댄 어윈');
    expect(startRowLine()).toBe('Moves 1 agent to this computer');
    expect(button('Move')).toBeDefined();
  });
});

describe('[SID:4576] the move refused', () => {
  const refuse = (status: number, code: string) => () => new Response(JSON.stringify({ data: null, error: { code } }), { status });
  const pressMove = async () => { await chooseMove(); await tick('댄 어윈'); await act(async () => { button('옮기기')!.click(); }); await settle(); };

  it('not_org_admin → the move\'s admin card, «다시 확인»', async () => {
    stub(refuse(403, 'not_org_admin'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    await pressMove();
    expect(text()).toContain('에이전트를 옮기려면 조직 관리자여야 해요');
    expect(text()).toContain('지금 계정은 이 조직의 관리자가 아니에요. 관리자에게 이 화면에서 옮겨 달라고 요청하거나, 관리자 권한을 받은 뒤 다시 열어 주세요.');
  });

  it('agent_not_found · agent_not_in_project → «옮길 에이전트가 달라졌어요» [목록 다시 불러오기] reads the agents again', async () => {
    for (const [status, code] of [[404, 'agent_not_found'], [422, 'agent_not_in_project']] as const) {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      stub(refuse(status, code));
      await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
      await pressMove();
      expect(text()).toContain('옮길 에이전트가 달라졌어요');
      expect(text()).toContain('이 페이지를 연 뒤 에이전트나 프로젝트가 바뀌어 지금 고른 대로는 옮길 수 없어요. 목록을 다시 불러와 골라 주세요.');
      calls = [];
      await act(async () => { button('목록 다시 불러오기')!.click(); });
      await settle();
      expect(calls.some((c) => c.url.includes('/api/desktop/setup/agents'))).toBe(true);
    }
  });

  it('a code this page never sends for (app_cannot_move · move_needs_existing_agents · roles_invalid) → the one-line generic text', async () => {
    for (const [status, code] of [[409, 'app_cannot_move'], [422, 'move_needs_existing_agents'], [422, 'roles_invalid']] as const) {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      stub(refuse(status, code));
      await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
      await pressMove();
      expect(text()).not.toContain('레시피가 달라졌어요');
      expect(text()).toContain(koMessages.desktop.setup.genericError);
    }
  });

  it('Kadir 4969 ①: the list comes back empty after «달라졌어요» → still the move way (empty box · [옮기기] off · «옮길 수 있는 에이전트가 없어요») — never the recipe page with a recipe chosen', async () => {
    stub(refuse(404, 'agent_not_found'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    await pressMove();
    agentsNow = () => new Response(JSON.stringify({ agents: [] }), { status: 200 });
    await act(async () => { button('목록 다시 불러오기')!.click(); });
    await settle();
    expect(container.querySelector('[data-testid=setup-move-empty]')?.textContent).toBe(koMessages.desktop.setup.move.listEmpty);
    expect((container.querySelector('input[name=setup-kind][value=move]') as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector('[data-testid=setup-recipe-chosen]')).toBeNull();
    expect(button('시작')).toBeUndefined();
    expect(button('옮기기')!.disabled).toBe(true);
    expect(startRowLine()).toBe('옮길 수 있는 에이전트가 없어요');
    expect(text()).not.toContain('작업 폴더는 옮긴 뒤'); // Yuna 05:39Z: no folder line when nothing can move
  });

  it('Kadir 4969 (2선): ticks follow the fresh list — an agent that dropped out and comes back is not ticked by itself', async () => {
    stub(refuse(404, 'agent_not_found'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    await pressMove(); // ticks 댄 어윈 → refused
    agentsNow = () => new Response(JSON.stringify({ agents: [KADIR] }), { status: 200 });
    await act(async () => { button('목록 다시 불러오기')!.click(); });
    await settle();
    await tick('까디르 QA');
    await act(async () => { button('옮기기')!.click(); });
    await settle(); // refused again
    agentsNow = () => new Response(JSON.stringify({ agents: [DAN, KADIR] }), { status: 200 });
    await act(async () => { button('목록 다시 불러오기')!.click(); });
    await settle();
    const dan = rows().find((r) => r.textContent?.includes('댄 어윈'))!;
    expect((dan.querySelector('input') as HTMLInputElement).checked).toBe(false);
  });

  it('offline → the offline card with the move\'s body («고른 에이전트는 그대로») · «다시 시도» sends the same move again', async () => {
    let n = 0;
    stub(() => { n++; if (n === 1) throw new TypeError('offline'); return new Response(JSON.stringify({ setup_id: 's-1', work_item_id: null, members: [] }), { status: 200 }); });
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    await pressMove();
    expect(text()).toContain('연결이 끊겼어요');
    expect(text()).toContain('인터넷 연결을 확인한 뒤 다시 시도해 주세요. 고른 에이전트는 그대로 남아 있어요.');
    await act(async () => { button('다시 시도')!.click(); });
    await settle();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual(posts[0].body);
  });
});

describe('[SID:4576] the move\'s progress — two steps, by name', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] }); vi.setSystemTime(Date.parse('2026-10-06T04:42:00Z')); });
  afterEach(() => { vi.useRealTimers(); });
  const read = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(10); }); for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
  const base = (signals: object, state = 'handed_over') => ({
    state, recipe_name: null, recipe: null, work_item_id: null, setup_kind: 'move',
    members: [{ stage: null, role: null, member_id: 'm-dan', kind: 'agent', runtime: 'claude', name: '댄 어윈' }, { stage: null, role: null, member_id: 'm-kad', kind: 'agent', runtime: 'codex', name: '까디르 QA' }],
    signals: { tools_connected: [], first_task_handed_at: null, first_result_at: null, workdir_fallback_at: null, blocked: null, ...signals },
  });

  it('waiting for its folder: step ① holds with the folder note (not «시작하지 못했어요») · ② waits', async () => {
    statusNow = () => base({ agents_start_failed: [{ member_id: 'm-dan', at: '2026-10-06T04:40:00Z', reason: 'workdir_needed', code: null, runtime: 'claude', limit: null, first_member_id: null }] });
    stub(() => new Response('{}'));
    await mount(<SetupProgressView setupId="s-1" recipeName="" />);
    await read();
    expect(text()).toContain('이 컴퓨터에서 시작하기 · 에이전트 옮기기');
    expect(text()).toContain('에이전트를 옮기고 있어요');
    expect(container.querySelector('[data-testid=setup-move-folder-wait]')?.textContent).toBe('댄 어윈은 작업 폴더를 고르면 시작해요 — 창 아래 «이 컴퓨터의 에이전트» 알림에서 [작업 폴더 고르기]를 눌러 주세요');
    expect(container.querySelector('[data-testid=setup-agent-start-failed]')).toBeNull();
    expect(text()).toContain('Sprintable에 연결해요'); // ② waiting
    expect(text()).not.toContain('첫 일감');
    expect(text()).not.toContain('결과 보기');
  });

  it('every agent connected → «에이전트를 옮겼어요» · «{이름} · {런타임}» · only [오늘로 가기] and the done line', async () => {
    statusNow = () => base({ tools_connected: [{ member_id: 'm-dan', at: '2026-10-06T04:41:00Z' }, { member_id: 'm-kad', at: '2026-10-06T04:41:02Z' }] });
    stub(() => new Response('{}'));
    await mount(<SetupProgressView setupId="s-1" recipeName="" />);
    await read();
    expect(text()).toContain('에이전트를 옮겼어요');
    expect(text()).toContain('댄 어윈 · Claude Code, 까디르 QA · Codex');
    expect(text()).toContain('Sprintable에 연결했어요');
    const out = container.querySelector('[data-testid=setup-way-out]') as HTMLElement;
    expect([...out.querySelectorAll('a,button')].map((b) => b.textContent)).toEqual(['오늘로 가기']);
    expect(text()).toContain('이제 이 컴퓨터에서 일해요 — 다음 일감은 평소처럼 받아요');
  });

  it('one connected, one still on its way → ① done with the pairs · ② running with «{이름}은 아직 연결하고 있어요» · the leaving line', async () => {
    statusNow = () => base({ tools_connected: [{ member_id: 'm-dan', at: '2026-10-06T04:41:00Z' }] });
    stub(() => new Response('{}'));
    await mount(<SetupProgressView setupId="s-1" recipeName="" />);
    await read();
    // Yuna 05:20Z: ① is done (the app took them over, «{이름} · {런타임}»); the agent still on its way is ②'s line
    const steps = [...container.querySelectorAll('li[data-state]')] as HTMLElement[];
    expect(steps[0].textContent).toBe('에이전트를 준비했어요댄 어윈 · Claude Code, 까디르 QA · Codex');
    expect(steps[1].querySelector('[data-testid=setup-still-preparing]')?.textContent).toBe('까디르 QA는 아직 연결하고 있어요'); // Yuna 05:39Z: ②'s word
    expect(steps[0].querySelector('[data-testid=setup-still-preparing]')).toBeNull();
    expect(text()).toContain('Sprintable에 연결하고 있어요');
    expect(text()).toContain('떠나도 옮기기는 이 컴퓨터에서 이어져요.');
  });

  it('every agent left stopped or not started → ② still (no spinner) and the reading settles', async () => {
    statusNow = () => base({ agents_ended: [{ member_id: 'm-dan', at: '2026-10-06T04:41:00Z', runtime: 'claude', exit_code: 1, restarted_at: null }],
      agents_start_failed: [{ member_id: 'm-kad', at: '2026-10-06T04:41:00Z', reason: 'runtime_missing', code: null, runtime: 'codex', limit: null, first_member_id: null }] });
    stub(() => new Response('{}'));
    await mount(<SetupProgressView setupId="s-1" recipeName="" />);
    await read();
    const steps = [...container.querySelectorAll('li[data-state]')] as HTMLElement[];
    expect(steps.map((s) => [s.dataset.state, s.dataset.paused ?? ''])).toEqual([['done', ''], ['running', 'true']]);
    // Yuna 05:22Z: no «ready» pair for an agent that stopped or could not start (here: both → no line under ①)
    expect(steps[0].textContent).toBe('에이전트를 준비했어요');
    expect(text()).toContain('까디르 QA를 시작하지 못했어요');
    expect(text()).toContain('댄 어윈이 멈췄어요');
    const n = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(calls.length).toBe(n); // settled: no more reading
  });

  it('one connected, one could not start → ① lists only the connected one · the failed one in its own block', async () => {
    statusNow = () => base({ tools_connected: [{ member_id: 'm-dan', at: '2026-10-06T04:41:00Z' }],
      agents_start_failed: [{ member_id: 'm-kad', at: '2026-10-06T04:41:00Z', reason: 'runtime_missing', code: null, runtime: 'codex', limit: null, first_member_id: null }] });
    stub(() => new Response('{}'));
    await mount(<SetupProgressView setupId="s-1" recipeName="" />);
    await read();
    const steps = [...container.querySelectorAll('li[data-state]')] as HTMLElement[];
    expect(steps[0].textContent).toBe('에이전트를 준비했어요댄 어윈 · Claude Code');
    expect(text()).toContain('까디르 QA를 시작하지 못했어요');
  });

  it('a recipe setup (setup_kind recipe · or none from an older server) keeps the three steps', async () => {
    statusNow = () => ({ ...base({}), setup_kind: undefined, recipe_name: '조사 한 명', members: [{ stage: 'research', role: '조사', member_id: 'm-1', kind: 'agent', runtime: 'claude' }] });
    stub(() => new Response('{}'));
    await mount(<SetupProgressView setupId="s-1" recipeName="조사 한 명" />);
    await read();
    expect(container.querySelector('[data-testid=setup-move-progress]')).toBeNull();
    expect(text()).toContain('결과 보기');
  });
});

describe('[SID:4576] moveProgress — the late not-connected agent (Kadir 4969 ② · the recipe\'s 4464 rule)', () => {
  const status = (): SetupStatus => ({ state: 'handed_over', recipe_name: null, work_item_id: null, setup_kind: 'move',
    members: [{ stage: null, role: null, member_id: 'm-dan', kind: 'agent', runtime: 'claude', name: 'Dan' }],
    signals: { tools_connected: [], first_task_handed_at: null, first_result_at: null, workdir_fallback_at: null, blocked: null } });
  it('before the threshold: still reading, ② spinning · past it: the block shows, ② still, the reading ends', () => {
    const t0 = Date.parse('2026-10-06T05:00:00Z');
    const early = moveProgress(status(), t0 + 60_000, t0);
    expect([early.settled, early.connectPaused, early.notConnected]).toEqual([false, false, null]);
    for (const m of [NOT_CONNECTED_AFTER_HANDOVER_MS, 10 * 60_000, 600 * 60_000]) {
      const late = moveProgress(status(), t0 + m, t0);
      expect([late.settled, late.connectPaused, late.notConnected?.names]).toEqual([true, true, ['Dan']]);
    }
  });
});

describe('[SID:4576] the address and the confirm body', () => {
  it('`caps=move` in the app\'s `#` → canMove (kept by the reload fragment) · absent → no canMove key at all', () => {
    const q = parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude&caps=move`))!;
    expect(q.canMove).toBe(true);
    expect(parseSetupFragment(setupFragment(q))!.canMove).toBe(true);
    const old = parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude`))!;
    expect('canMove' in old).toBe(false);
    expect(setupFragment(old)).not.toContain('caps');
    expect(parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude&caps=other`))!.canMove).toBeUndefined();
  });

  it('moveConfirmBody: each agent once, no recipe or folder · moveListOrder: movable first, server order kept inside each group', () => {
    expect(moveConfirmBody(CODE, 'p-1', ['a', 'b', 'a'])).toEqual({ code: CODE, project_id: 'p-1', roles: [{ role: 'move', agent_id: 'a' }, { role: 'move', agent_id: 'b' }] });
    expect(moveListOrder([DAMRONG, DAN, KADIR], ['claude']).map((a) => a.id)).toEqual(['a-dan', 'a-dam', 'a-kadir']);
  });
});
