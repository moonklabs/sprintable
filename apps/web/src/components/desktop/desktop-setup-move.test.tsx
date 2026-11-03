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
import { moveConfirmBody, moveListOrder, moveRowState, moveProgress, parseSetupQuery, setupFragment, parseSetupFragment, NOT_CONNECTED_AFTER_HANDOVER_MS, type AttachableAgent, type SetupStatus } from '@/lib/desktop-setup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const RECIPES = [{ id: 'rec-1', key: 'org.research_one', name: '조사 한 명', roles: [{ role: '조사', kind: 'agent', stages: ['research'] }] }];
// story 4680 (Yuna G-4): the «connection is cut» note needs a key that was used — a never-used key has nothing to cut (no line)
const DAN: AttachableAgent = { id: 'a-dan', name: '댄 어윈', runtime: 'claude', live_keys: 1, last_used_at: new Date(Date.now() - 5 * 60_000).toISOString(), in_project: true };
const KADIR: AttachableAgent = { id: 'a-kadir', name: '까디르 QA', runtime: 'codex', live_keys: 0, last_used_at: null, in_project: true };
const DAMRONG: AttachableAgent = { id: 'a-dam', name: '담롱', runtime: 'claude', live_keys: 0, last_used_at: null, in_project: false };

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; method?: string; body?: unknown }[];
let agentsNow: () => Response;
let statusNow: () => unknown = () => ({});
// story 4670 AC1 — GET/PUT /api/organizations/{id}/remote-control (default 404: not known → no «폰에서도 다루기» row)
const REMOTE_OFF_OWNER = { enabled: false, can_change: true, enabled_at: null };
let remoteGet: () => Response = () => new Response('{}', { status: 404 });
let remotePut: () => Response = () => new Response(JSON.stringify({ data: { enabled: true, can_change: true, enabled_at: 'now' } }), { status: 200 });

function stub(confirm: () => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/api/desktop/recipes')) return new Response(JSON.stringify({ recipes: RECIPES }), { status: 200 });
    if (url.includes('/api/desktop/setup/agents')) return agentsNow();
    if (url.includes('/api/desktop/setup-codes/')) return confirm();
    if (url.includes('/api/desktop/setups/')) return new Response(JSON.stringify(statusNow()), { status: 200 });
    if (/\/api\/organizations\/[^/]+\/remote-control$/.test(url)) return init?.method === 'PUT' ? remotePut() : remoteGet();
    return new Response('{}', { status: 404 });
  }));
}
async function mount(node: React.ReactNode, locale: 'ko' | 'en' = 'ko', several = false) {
  ctx.mockReturnValue({ projectId: several ? undefined : 'p-1', currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }],
    projectMemberships: several ? [{ projectId: 'p-1', projectName: 'A', orgId: 'o-1' }, { projectId: 'p-2', projectName: 'B', orgId: 'o-1' }] : [] });
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const text = () => container.textContent ?? '';
/** the visible radio/checkbox part (a span role=radio|checkbox): checked = aria-checked, off = data-disabled */
const isOn = (el: Element | null | undefined) => el?.getAttribute('aria-checked') === 'true';
const isOff = (el: Element | null | undefined) => el?.hasAttribute('data-disabled') === true;
const kindRadio = (v: 'recipe' | 'move') => container.querySelectorAll('[data-testid=setup-kind] [role=radio]')[v === 'recipe' ? 0 : 1] as HTMLElement;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const chooseMove = async () => { await act(async () => { kindRadio('move').click(); }); };
const rows = () => [...container.querySelectorAll('[data-testid=setup-move-row]')] as HTMLElement[];
const tick = async (name: string) => {
  const row = rows().find((r) => r.textContent?.includes(name))!;
  await act(async () => { (row.querySelector('[role=checkbox]') as HTMLElement).click(); });
};
const startRowLine = () => (container.querySelector('[data-testid=setup-start-row] p') as HTMLElement).textContent;

beforeEach(() => {
  remoteGet = () => new Response('{}', { status: 404 });
  remotePut = () => new Response(JSON.stringify({ data: { enabled: true, can_change: true, enabled_at: 'now' } }), { status: 200 });
  agentsNow = () => new Response(JSON.stringify({ agents: [DAMRONG, DAN, KADIR] }), { status: 200 });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); sessionStorage.clear(); });

// ── story 4832 (PO 11-03 «팀에 넣고 옮기기»): a row not on the project's team is tickable — moving it puts it on the team (one confirmation, `add_to_team`) ──
describe('[SID:4832] the move list · a row not on the team', () => {
  const ZED: AttachableAgent = { id: 'a-zed', name: '제드', runtime: 'codex', live_keys: 0, last_used_at: null, in_project: false };
  const rowOf = (name: string) => rows().find((r) => r.textContent?.includes(name))!;
  const putButtons = () => container.querySelectorAll('[data-testid=setup-put-on-team]');

  it('the line is there BEFORE any tick, the row is tickable but not ticked, there is no separate «프로젝트 팀에 넣기» button here, and a program this computer lacks stays the blocker', async () => {
    stub(() => new Response('{}'));
    agentsNow = () => new Response(JSON.stringify({ agents: [DAMRONG, DAN, KADIR, ZED] }), { status: 200 });
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} canMove />);
    await chooseMove();
    const row = rowOf('담롱');
    expect(row.dataset.state).toBe('needs-team');
    expect(row.textContent).toContain('Claude Code 에이전트 · 옮기면 프로젝트 팀에도 들어가요'); // line removed → fails
    expect(isOff(row.querySelector('[role=checkbox]'))).toBe(false); // tickable
    expect(isOn(row.querySelector('[role=checkbox]'))).toBe(false); // never pre-ticked
    expect(putButtons()).toHaveLength(0); // the move list has one way, not two
    // Codex is not on this computer: the blocker is the runtime — said once, whatever the team says
    for (const name of ['제드', '까디르 QA']) {
      expect(rowOf(name).dataset.state).toBe('runtime-missing');
      expect(rowOf(name).textContent).toContain('Codex가 이 컴퓨터에 없어요');
      expect(isOff(rowOf(name).querySelector('[role=checkbox]'))).toBe(true);
    }
    expect(rowOf('제드').textContent).not.toContain('팀에도 들어가요');
  });

  it('[옮기기] sends add_to_team for the ticked agent that is off the team — and only for that one', async () => {
    stub(() => new Response(JSON.stringify({ setup_id: 's-1', work_item_id: null, members: [] }), { status: 200 }));
    agentsNow = () => new Response(JSON.stringify({ agents: [DAMRONG, DAN] }), { status: 200 });
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} canMove setupId="s-1" />);
    await chooseMove();
    await tick('담롱');
    await tick('댄 어윈');
    expect(startRowLine()).toBe('에이전트 2개를 이 컴퓨터로 옮겨요');
    calls = [];
    await act(async () => { button('옮기기')!.click(); });
    await settle();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain('/api/desktop/setup-codes/confirm');
    expect(posts[0].body).toEqual({ code: CODE, project_id: 'p-1', roles: [{ role: 'move', agent_id: 'a-dam', add_to_team: true }, { role: 'move', agent_id: 'a-dan' }] }); // the ask on every ticked row → fails
  });

  it('an agent ticked and then unticked asks for nothing; one off the team alone is movable (the start button is on)', async () => {
    stub(() => new Response(JSON.stringify({ setup_id: 's-1', work_item_id: null, members: [] }), { status: 200 }));
    agentsNow = () => new Response(JSON.stringify({ agents: [DAMRONG] }), { status: 200 });
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} canMove setupId="s-1" />);
    await chooseMove();
    expect(button('옮기기')!.disabled).toBe(true);
    await tick('담롱');
    expect(button('옮기기')!.disabled).toBe(false);
    await tick('담롱');
    expect(button('옮기기')!.disabled).toBe(true);
    await tick('담롱');
    calls = [];
    await act(async () => { button('옮기기')!.click(); });
    await settle();
    expect(calls.filter((c) => c.method === 'POST')[0]!.body).toEqual({ code: CODE, project_id: 'p-1', roles: [{ role: 'move', agent_id: 'a-dam', add_to_team: true }] });
  });
});

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
    expect(isOn(kindRadio('recipe'))).toBe(true);
    // the recipe way's head line stays as it was
    expect(text()).toContain('레시피를 고르면 이 컴퓨터의 에이전트가 역할을 맡아 바로 첫 일감을 시작해요.');
    await chooseMove();
    expect(text()).toContain('옮길 에이전트를 고르면 이 컴퓨터의 앱이 받아 가요 — 맡은 역할 · 일감 · 프로젝트 설정은 그대로이고, 첫 일감은 따로 만들지 않아요.');
    expect(container.querySelector('[data-testid=setup-recipe-chosen]')).toBeNull();
    expect(container.querySelector('#setup-roles')).toBeNull();
    expect(container.querySelector('#setup-folder')).toBeNull();
    expect(text()).toContain('이 컴퓨터에서 찾은 에이전트: Claude Code · Codex');
    expect(rows().map((r) => [r.querySelector('.font-medium')!.textContent, r.dataset.state])).toEqual([['댄 어윈', 'ok'], ['까디르 QA', 'ok'], ['담롱', 'needs-team']]);
    expect(rows()[0].textContent).toContain('Claude Code 에이전트 · 이 컴퓨터로 옮길 수 있어요'); // 4832: the tool being here is not the agent being here
    expect(rows()[0].textContent).not.toContain('이 컴퓨터에 있음');
    expect(rows()[2].textContent).toContain('옮기면 프로젝트 팀에도 들어가요'); // 4832: the line says it before any tick; no separate button
    expect(rows()[2].querySelector('[data-testid=setup-put-on-team]')).toBeNull();
    expect(isOff(rows()[2].querySelector('[role=checkbox]'))).toBe(false); // 4832: tickable (moving it puts it on the team)
    expect(rows().every((r) => !isOn(r.querySelector('[role=checkbox]')))).toBe(true);
    expect(text()).toContain('작업 폴더는 옮긴 뒤 앱에서 에이전트마다 골라요 — 이 컴퓨터에서 일한 적이 있는 에이전트는 그 폴더를 그대로 써요');
    expect(button('옮기기')!.disabled).toBe(true);
    expect(startRowLine()).toBe('옮길 에이전트를 하나 이상 골라 주세요');
    expect(button('시작')).toBeUndefined();
  });

  it('only rows that cannot move → the start line says none can be moved (each row keeps its why)', async () => {
    agentsNow = () => new Response(JSON.stringify({ agents: [KADIR] }), { status: 200 }); // a codex agent on a computer that has only claude (4832: an agent off the team is no longer a blocker by itself)
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} canMove />);
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
    expect(isOff(kadir.querySelector('[role=checkbox]'))).toBe(true);
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
    expect(isOff(move.querySelector('[role=radio]'))).toBe(true);
    expect(container.querySelector('[data-testid=setup-kind-move-why]')?.textContent).toBe('이 앱 판에서는 옮길 수 없어요 — 앱을 업데이트해 주세요');
    expect(move.textContent).not.toContain('이 조직에서 일하던 에이전트를 이 컴퓨터로 옮겨요');
    // a click on it changes nothing: still the recipe way, no move list, «시작»
    await act(async () => { (move.querySelector('[role=radio]') as HTMLElement).click(); (move as HTMLElement).click(); });
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

describe('[SID:4576] Kadir 4969 (2선) — no switching mid-start · no old ticks into a new project', () => {
  it('while a start is on its way both ways are locked (an offline retry repeats what was sent)', async () => {
    stub(() => new Promise<Response>(() => undefined)); // the confirm never answers: «시작 중»
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    await act(async () => { button('시작')!.click(); });
    await settle();
    const radios = [...container.querySelectorAll('[data-testid=setup-kind] [role=radio]')] as HTMLElement[];
    expect(radios.map((r) => isOff(r))).toEqual([true, true]);
  });

  it('changing the project unticks at once — the old project\'s ticks never go with the new project id', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />, 'ko', true);
    const pick = () => container.querySelector('[data-testid=setup-project-pick] select[data-slot="select"]') as HTMLSelectElement;
    const choose = async (v: string) => { await act(async () => { const el = pick(); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); }); await settle(); };
    await choose('p-1');
    await chooseMove();
    await tick('댄 어윈');
    expect(startRowLine()).toBe('에이전트 1개를 이 컴퓨터로 옮겨요');
    await choose('p-2'); // the same agents come back for B
    const dan = rows().find((r) => r.textContent?.includes('댄 어윈'))!;
    expect(isOn(dan.querySelector('[role=checkbox]'))).toBe(false);
    expect(startRowLine()).toBe('옮길 에이전트를 하나 이상 골라 주세요');
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
    expect(isOn(kindRadio('move'))).toBe(true);
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
    expect(isOn(dan.querySelector('[role=checkbox]'))).toBe(false);
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

  // story 4670 AC1: the move is the new customer's usual road — its end screen carries the phone's way in too (the QR block · [폰 페어링 열기]
  // · the remote-control [켜기]), and the progress head's «아래 카드에서 다시 켤 수 있어요» line points at that card
  it('story 4670 AC1: settled → the phone card is below (owner: [폰 페어링 열기]) · not settled yet → no card', async () => {
    statusNow = () => base({ tools_connected: [{ member_id: 'm-dan', at: '2026-10-06T04:41:00Z' }, { member_id: 'm-kad', at: '2026-10-06T04:41:02Z' }] });
    stub(() => new Response('{}'));
    await mount(<SetupProgressView setupId="s-1" recipeName="" />);
    await read();
    expect(container.querySelector('[data-testid=setup-phone-card] [data-testid=setup-phone-pair]')).not.toBeNull();
    act(() => root.unmount()); root = createRoot(container);
    statusNow = () => base({ tools_connected: [{ member_id: 'm-dan', at: '2026-10-06T04:41:00Z' }] });
    await mount(<SetupProgressView setupId="s-1" recipeName="" />);
    await read();
    expect(container.querySelector('[data-testid=setup-phone-card]')).toBeNull();
  });

  it('story 4670 AC1: the tick was on but the switch did not turn on → the head says it on the move\'s progress, and before the first reading too', async () => {
    const line = () => container.querySelector('[data-testid=setup-phone-control-failed]')?.textContent;
    statusNow = () => ({});
    stub(() => new Response('{}'));
    await mount(<SetupProgressView setupId="s-1" recipeName="" phoneControlFailed />);
    await read();
    expect(line()).toBe('폰 다루기는 켜지 못했어요 — 끝나면 아래 카드에서 다시 켤 수 있어요.'); // no status yet
    act(() => root.unmount()); root = createRoot(container);
    statusNow = () => base({});
    await mount(<SetupProgressView setupId="s-1" recipeName="" phoneControlFailed />);
    await read();
    expect(container.querySelector('[data-testid=setup-move-progress]')).not.toBeNull();
    expect(line()).toBe('폰 다루기는 켜지 못했어요 — 끝나면 아래 카드에서 다시 켤 수 있어요.');
    act(() => root.unmount()); root = createRoot(container);
    await mount(<SetupProgressView setupId="s-1" recipeName="" />);
    await read();
    expect(line()).toBeUndefined();
  });

  it('one connected, one still on its way → ① done with the pairs · ② running with «{이름}은 시작했어요 — Sprintable에 첫 연결을 기다려요» · the leaving line', async () => {
    statusNow = () => base({ tools_connected: [{ member_id: 'm-dan', at: '2026-10-06T04:41:00Z' }] });
    stub(() => new Response('{}'));
    await mount(<SetupProgressView setupId="s-1" recipeName="" />);
    await read();
    // Yuna 05:20Z: ① is done (the app took them over, «{이름} · {런타임}»); the agent still on its way is ②'s line
    const steps = [...container.querySelectorAll('li[data-state]')] as HTMLElement[];
    expect(steps[0].textContent).toBe('에이전트를 준비했어요댄 어윈 · Claude Code, 까디르 QA · Codex');
    expect(steps[1].querySelector('[data-testid=setup-still-preparing]')?.textContent).toBe('까디르 QA는 시작했어요 — Sprintable에 첫 연결을 기다려요'); // 4832: the same word the app's strip says («시작했어요»), then what is awaited
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
    // 4832: an agent off the team whose program is here is movable too (the move puts it on the team) — after the ready ones; only a program this computer lacks sorts last
    expect(moveListOrder([DAMRONG, DAN, KADIR], ['claude']).map((a) => a.id)).toEqual(['a-dan', 'a-dam', 'a-kadir']);
    expect(moveListOrder([KADIR, DAMRONG, DAN], ['claude']).map((a) => a.id)).toEqual(['a-dan', 'a-dam', 'a-kadir']);
  });

  it('[SID:4832] moveConfirmBody: add_to_team rides only on the agents asked for that are also in the move · moveRowState: only a missing program blocks', () => {
    expect(moveConfirmBody(CODE, 'p-1', ['a', 'b'], ['b'])).toEqual({ code: CODE, project_id: 'p-1', roles: [{ role: 'move', agent_id: 'a' }, { role: 'move', agent_id: 'b', add_to_team: true }] });
    expect(moveConfirmBody(CODE, 'p-1', ['a'], ['zzz'])).toEqual({ code: CODE, project_id: 'p-1', roles: [{ role: 'move', agent_id: 'a' }] }); // an id that is not in the move asks for nothing
    expect(moveConfirmBody(CODE, 'p-1', ['a'])).toEqual({ code: CODE, project_id: 'p-1', roles: [{ role: 'move', agent_id: 'a' }] }); // no ask: the body an older server reads
    expect([DAN, DAMRONG, KADIR].map((a) => moveRowState(a, ['claude']))).toEqual(['ok', 'needs-team', 'runtime-missing']);
    expect(moveRowState({ ...KADIR, in_project: false }, ['claude'])).toBe('runtime-missing'); // the blocker stays whatever the team says
  });
});

// ── story 4670 AC1 (PO dev walk 10-15): the hire → «이 컴퓨터에서 시작» road lands on «옮기기» (the agent just made is an «existing
// agent»). The tick above «시작» was drawn for the recipe start only — on this road it was not there, and no PUT was ever sent. ──
describe('[SID:4670] «폰으로도 에이전트 다루기» on the move road (the new customer\'s usual road)', () => {
  const row = () => container.querySelector('[data-testid=setup-phone-control]');
  const puts = () => calls.filter((c) => c.method === 'PUT' && /\/remote-control$/.test(c.url));
  const confirmOk = () => new Response(JSON.stringify({ setup_id: 'a'.repeat(8) + '-0000-4000-8000-000000000001', members: [], work_item_id: 'w-1' }), { status: 200 });
  const pressMoveStart = async () => { await chooseMove(); await tick('댄 어윈'); calls = []; await act(async () => { button('옮기기')!.click(); }); await settle(); };

  it('the hire road: recruiter preselect → «옮기기» → the row is there and ticked → [옮기기] = the confirmation first, then ONE PUT {enabled:true} for this session\'s org', async () => {
    remoteGet = () => new Response(JSON.stringify({ data: REMOTE_OFF_OWNER }), { status: 200 });
    stub(confirmOk);
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove preselect="a-dan" />);
    await chooseMove();
    expect(isOn(row()!.querySelector('[role=checkbox]'))).toBe(true);
    await pressMoveStart();
    expect(calls.map((c) => `${c.method ?? 'GET'} ${c.url}`).filter((u) => !u.includes('/api/desktop/setups/'))).toEqual([
      'POST /api/desktop/setup-codes/confirm', 'PUT /api/organizations/o-1/remote-control',
    ]);
    expect(puts()[0]!.body).toEqual({ enabled: true });
  });

  it('the row follows the way: there on «레시피로 시작» and on «옮기기» (one row, not two)', async () => {
    remoteGet = () => new Response(JSON.stringify({ data: REMOTE_OFF_OWNER }), { status: 200 });
    stub(confirmOk);
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    expect(container.querySelectorAll('[data-testid=setup-phone-control]')).toHaveLength(1);
    await chooseMove();
    expect(container.querySelectorAll('[data-testid=setup-phone-control]')).toHaveLength(1);
  });

  it('unticked → the move is sent and NO switch call', async () => {
    remoteGet = () => new Response(JSON.stringify({ data: REMOTE_OFF_OWNER }), { status: 200 });
    stub(confirmOk);
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    await chooseMove();
    await act(async () => { (row()!.querySelector('[role=checkbox]') as HTMLElement).click(); });
    await pressMoveStart();
    expect(calls.some((c) => c.url === '/api/desktop/setup-codes/confirm')).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it('the move is refused → no switch call (the PUT never rides ahead of the confirmation)', async () => {
    remoteGet = () => new Response(JSON.stringify({ data: REMOTE_OFF_OWNER }), { status: 200 });
    stub(() => new Response(JSON.stringify({ error: { code: 'agents_changed' } }), { status: 409 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    await pressMoveStart();
    expect(calls.some((c) => c.url === '/api/desktop/setup-codes/confirm')).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it('no row — and no PUT — when the switch is already on · the person cannot change it', async () => {
    for (const get of [
      () => new Response(JSON.stringify({ data: { enabled: true, can_change: true, enabled_at: 'x' } }), { status: 200 }),
      () => new Response(JSON.stringify({ data: { enabled: false, can_change: false, enabled_at: null } }), { status: 200 }),
    ]) {
      remoteGet = get;
      stub(confirmOk);
      await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
      await chooseMove();
      expect(row()).toBeNull();
      await pressMoveStart();
      expect(puts()).toHaveLength(0);
      act(() => root.unmount()); root = createRoot(container);
    }
  });

  it('the value could not be read (a final answer) → the box is drawn UNTICKED on the move road too · no PUT unless ticked by hand', async () => {
    remoteGet = () => new Response('{}', { status: 404 });
    stub(confirmOk);
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    await chooseMove();
    expect(isOn(row()!.querySelector('[role=checkbox]'))).toBe(false);
    await pressMoveStart();
    expect(puts()).toHaveLength(0);
  });

  it('the switch call is refused: the move still goes on, and the progress head says it (the line the recipe road already has)', async () => {
    remoteGet = () => new Response(JSON.stringify({ data: REMOTE_OFF_OWNER }), { status: 200 });
    remotePut = () => new Response('{}', { status: 403 });
    stub(confirmOk);
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove />);
    await pressMoveStart();
    expect(puts()).toHaveLength(1);
    expect(container.querySelector('[data-testid=setup-phone-control-failed]')?.textContent).toBe('폰 다루기는 켜지 못했어요 — 끝나면 아래 카드에서 다시 켤 수 있어요.'); // (no status read yet: the card before it carries the line too)
  });
});

describe('[SID:4831] the move list tick is the base Checkbox (a label press, Space, Enter)', () => {
  it('pressing the row\'s name (the label) ticks it and again unticks it · Enter does not tick · Space does · a row whose program is missing stays off', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} canMove />);
    await chooseMove();
    const row = rows().find((r) => r.textContent?.includes('댄 어윈'))!;
    const box = () => row.querySelector('[role=checkbox]') as HTMLElement;
    expect(box().getAttribute('data-slot')).toBe('checkbox');
    expect(isOn(box())).toBe(false);
    const name = row.querySelector('label') as HTMLElement;
    await act(async () => { name.click(); });
    expect(isOn(box())).toBe(true);
    await act(async () => { name.click(); });
    expect(isOn(box())).toBe(false);
    await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(isOn(box())).toBe(false);
    await act(async () => {
      box().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      box().dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
    });
    expect(isOn(box())).toBe(true);
    const off = rows().find((r) => r.dataset.state === 'runtime-missing')!; // 4832: only a program this computer lacks blocks now (a codex agent here, claude only on the computer)
    await act(async () => { (off.querySelector('label') as HTMLElement).click(); });
    expect(isOn(off.querySelector('[role=checkbox]'))).toBe(false);
  });
});

describe('[SID:4832] the page can open with «이미 있는 에이전트 옮기기» chosen', () => {
  const kindOn = (v: 'recipe' | 'move') => isOn(kindRadio(v));

  it('initialKind=move + an app that can move: the move radio is on at first sight and the agents are listed — nothing ticked', async () => {
    agentsNow = () => new Response(JSON.stringify({ agents: [DAN, KADIR] }), { status: 200 });
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} canMove initialKind="move" />);
    expect(kindOn('move')).toBe(true); // initialKind unused → recipe is on → fails
    expect(kindOn('recipe')).toBe(false);
    expect(container.querySelector('[data-testid=setup-recipe-chosen]')).toBeNull();
    expect(container.querySelectorAll('[data-testid=setup-move-row]').length).toBe(2);
    expect([...container.querySelectorAll('[data-testid=setup-move-row] [role=checkbox]')].some((c) => isOn(c))).toBe(false); // choosing the way is not choosing the agents
  });

  it('without canMove the hint changes nothing (an app that cannot take a move keeps the recipe page)', async () => {
    agentsNow = () => new Response(JSON.stringify({ agents: [DAN] }), { status: 200 });
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} initialKind="move" />);
    expect(container.querySelector('[data-testid=setup-recipe-chosen]')).not.toBeNull();
  });

  it('without canMove and with nothing to move, the hint draws no choice at all (the kind choice is drawn for a move that was asked, so an unkept ask must not draw it)', async () => {
    agentsNow = () => new Response(JSON.stringify({ agents: [] }), { status: 200 });
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} initialKind="move" />);
    expect(container.querySelector('[data-testid=setup-kind]')).toBeNull(); // initialKind used without canMove → the choice is drawn → fails
    expect(container.querySelector('[data-testid=setup-recipe-chosen]')).not.toBeNull();
  });

  it('the address: kind=move rides with caps=move only; any other value is dropped; the fragment keeps it across a reload', () => {
    const base = `#code=${CODE}&runtimes=claude`;
    expect(parseSetupFragment(`${base}&caps=move&kind=move`)!.kind).toBe('move');
    expect(parseSetupFragment(`${base}&caps=move,solo&kind=move`)!.kind).toBe('move');
    expect(parseSetupFragment(`${base}&kind=move`)!.kind).toBeUndefined(); // an app that cannot take a move
    expect(parseSetupFragment(`${base}&caps=move&kind=recipe`)!.kind).toBeUndefined();
    expect(parseSetupFragment(`${base}&caps=move`)!.kind).toBeUndefined();
    const q = parseSetupFragment(`${base}&caps=move,solo&kind=move`)!;
    expect(parseSetupFragment(setupFragment(q))!.kind).toBe('move');
    expect(setupFragment(parseSetupFragment(`${base}&caps=move`)!)).not.toContain('kind=');
  });
});

