// @vitest-environment jsdom
//
// story 4711 — the `agent=` branch: the page opened with a recruiter's agent. The card's ① is FIXED to that agent and «시작» is the MOVE confirmation
// (`{role, agent_id}`, no recipe, no runtime row): the agent is one the organization already has, so the exchange revokes every key it had — the key
// the in-app hire handed to the browser dies there (Kadir's lens on 5123). Not movable now → the recipe page with its reasons, never a new agent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { ctx } = vi.hoisted(() => ({ ctx: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx() }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useSearchParams: () => null }));
vi.mock('@/lib/ee', () => ({ isEEEnabled: () => false }));

import { ATTACHABLE_READ_LIMIT_MS, DesktopSetupEntry } from './desktop-setup';
import { __resetOrgRemoteControlForTest } from '@/lib/org-remote-control';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const PROJ = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
let container: HTMLDivElement;
let root: Root;
let calls: { url: string; method?: string; body?: unknown }[];
let agents: () => Response;
let confirmNow: () => Response | Promise<Response>;
const confirmOk = () => new Response(JSON.stringify({ setup_id: 's-1', members: [], work_item_id: null }), { status: 200 });

const list = (over: object = {}) => () => new Response(JSON.stringify({ agents: [{ id: AGENT, name: 'Dan', runtime: 'claude', live_keys: 0, last_used_at: null, in_project: true, ...over }] }), { status: 200 });

beforeEach(() => {
  __resetOrgRemoteControlForTest();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  agents = list();
  confirmNow = confirmOk;
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.method ? { method: init.method } : {}), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/api/desktop/setup/agents')) return agents();
    if (url.endsWith('/api/desktop/setup-codes/confirm')) return confirmNow();
    if (url.includes('/remote-control')) return new Response(JSON.stringify({ data: { enabled: true, can_change: true, enabled_at: 'x' } }), { status: 200 });
    if (url.endsWith('/api/desktop/recipes')) return new Response(JSON.stringify({ recipes: [], agent_room: { limit: 3, current: 3, available: 0, tier: 'free' } }), { status: 200 }); // story 4717: a FULL room — the move must not care
    return new Response('{}', { status: 404 });
  }));
  ctx.mockReturnValue({ projectId: PROJ, currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }], projectMemberships: [{ projectId: PROJ, projectName: '내 프로젝트', orgId: 'o-1' }] });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); window.location.hash = ''; });

async function open(hash: string) {
  window.location.hash = hash;
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopSetupEntry /></NextIntlClientProvider>); });
  for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const frag = (caps: string, extra = '') => `#code=${CODE}&runtimes=claude,codex&caps=${caps}&rv=claude:2.1.289&agent=${AGENT}${extra}`;
const text = () => container.textContent ?? '';
const start = () => [...container.querySelectorAll('button')].find((b) => b.textContent === '시작') as HTMLButtonElement | undefined;

describe('[SID:4711] the `agent=` branch of the setup page', () => {
  it('a movable recruiter\'s agent: the card with ① fixed to it (no radio · no folder step · no team link) and the project line', async () => {
    await open(frag('move,solo'));
    expect(container.querySelector('[data-testid=quick-agent-fixed]')!.textContent).toContain('Dan');
    expect(container.querySelector('[data-testid=quick-agent-fixed]')!.textContent).toContain('Claude Code 2.1.289');
    expect(container.querySelector('input[name=quick-runtime]')).toBeNull();
    expect(container.querySelector('[data-testid=quick-folder]')).toBeNull();
    expect(text()).not.toContain('폴더 고르기');
    expect(text()).not.toContain('여러 에이전트로 팀 꾸리기');
    expect(container.querySelector('[data-testid=quick-start-line]')!.textContent).toBe('프로젝트 · 내 프로젝트');
    expect(start()!.disabled).toBe(false);
  });

  it('the card from a hire is titled after THAT agent — «{name} 에이전트 시작하기» — not the generic title (story 4710 correction)', async () => {
    await open(frag('move,solo'));
    expect(container.querySelector('[data-testid=quick-card] h1')!.textContent).toBe('Dan 에이전트 시작하기');
    expect(text()).not.toContain('이 컴퓨터에서 에이전트 시작하기');
  });

  it('«시작» = the MOVE confirmation: {code, project_id, roles:[{role, agent_id}]} — no recipe, no runtime row, never confirm-solo', async () => {
    await open(frag('move,solo'));
    await act(async () => { start()!.click(); });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((p) => p.url)).toContain('/api/desktop/setup-codes/confirm');
    expect(posts.some((p) => p.url.includes('confirm-solo'))).toBe(false);
    const body = posts.find((p) => p.url === '/api/desktop/setup-codes/confirm')!.body as { roles: Record<string, unknown>[]; recipe_id?: unknown };
    expect(body).toEqual({ code: CODE, project_id: PROJ, roles: [{ role: 'move', agent_id: AGENT }] });
    expect(body.recipe_id).toBeUndefined();
    expect(body.roles.every((r) => r.runtime === undefined && r.owner === undefined)).toBe(true); // no new agent, no «me»
  });

  it('codex self-QA: after a move the progress and the reload address use the setup the SERVER answered (shape-checked); a nonsense id falls back to the address\'s own', async () => {
    const SERVER_ID = '33333333-3333-4333-8333-cccccccccccc';
    confirmNow = () => new Response(JSON.stringify({ setup_id: SERVER_ID, members: [], work_item_id: null }), { status: 200 });
    await open(frag('move,solo', '&setup=11111111-1111-4111-8111-aaaaaaaaaaaa'));
    await act(async () => { start()!.click(); });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(window.location.hash).toBe(`#progress=${SERVER_ID}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(calls.some((c) => c.url.includes(`/api/desktop/setups/${SERVER_ID}`))).toBe(true);
    // anything that is not a uuid is not a setup id (the progress route takes nothing else; a code-like string must not reach the address): the address's own stands
    for (const bad of ['a/../b', 's-1', 'x'.repeat(43)]) {
      await act(async () => { root.render(<div />); });
      confirmNow = () => new Response(JSON.stringify({ setup_id: bad, members: [], work_item_id: null }), { status: 200 });
      await open(frag('move,solo', '&setup=11111111-1111-4111-8111-aaaaaaaaaaaa'));
      await act(async () => { start()!.click(); });
      for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(window.location.hash).toBe('#progress=11111111-1111-4111-8111-aaaaaaaaaaaa');
    }
  });

  it('codex self-QA: an address whose setup= is not a uuid and an answer without a valid id → the plain «started» card, NO progress route is ever read with the bad id', async () => {
    confirmNow = () => new Response(JSON.stringify({ members: [], work_item_id: null }), { status: 200 });
    await open(frag('move,solo', '&setup=s-1'));
    await act(async () => { start()!.click(); });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    expect(calls.some((c) => c.url.includes('/api/desktop/setups/s-1'))).toBe(false);
    expect(window.location.hash).not.toContain('s-1');
  });

  it('codex self-QA: two presses of [시작] before the card redraws send ONE move confirmation', async () => {
    await open(frag('move,solo'));
    const go = start()!;
    await act(async () => { go.click(); go.click(); });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/desktop/setup-codes/confirm').length).toBe(1);
  });

  it('[SID:4717] a full agent room does not hold the MOVE: the agent already exists, so «시작» stays on, no room box, and the card does not even read the room', async () => {
    await open(frag('move,solo'));
    expect(start()!.disabled).toBe(false);
    expect(container.querySelector('[data-testid=setup-room-short]')).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/api/desktop/recipes'))).toBe(false);
    await act(async () => { start()!.click(); });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/desktop/setup-codes/confirm').length).toBe(1);
  });

  it('an app that can take only a move (no solo) gets the same branch', async () => {
    await open(frag('move'));
    expect(container.querySelector('[data-testid=quick-agent-fixed]')).not.toBeNull();
  });

  it('the agent works somewhere else (a live key): the move\'s warning shows under it', async () => {
    agents = list({ live_keys: 1, last_used_at: new Date(Date.now() - 3600_000).toISOString() });
    await open(frag('move,solo'));
    expect(container.querySelector('[data-testid=setup-moved-note]')!.textContent).toContain('이 에이전트의 지금 연결이 끊겨요');
  });

  it('not movable now → the recipe page with its reasons, never the card and never a start of a new agent', async () => {
    for (const over of [{ in_project: false }, { runtime: 'codex' }]) {
      agents = list(over);
      calls.length = 0;
      await open(frag('move,solo', over.runtime ? '' : '').replace('runtimes=claude,codex', 'runtimes=claude'));
      expect(container.querySelector('[data-testid=quick-agent-fixed]')).toBeNull();
      expect(container.querySelector('[data-testid=quick-card]')).toBeNull();
      expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
      expect(calls.some((c) => c.url.endsWith('/api/desktop/recipes'))).toBe(true); // the recipe page (with its reasons) is what shows
      await act(async () => { root.render(<div />); });
    }
  });

  it('the agents list could not be read → the recipe page (its own «failed» reading), not the card', async () => {
    agents = () => new Response('{}', { status: 500 });
    await open(frag('move,solo'));
    expect(container.querySelector('[data-testid=quick-agent-fixed]')).toBeNull();
    expect(container.querySelector('[data-testid=quick-card]')).toBeNull();
  });

  it('Kadir: an agent= id that is NOT in the list (stale / someone else\'s) is never swapped for another agent — the recipe page, no move confirmation at all', async () => {
    const other = (id: string, name: string) => ({ id, name, runtime: 'claude', live_keys: 1, last_used_at: null, in_project: true });
    agents = () => new Response(JSON.stringify({ agents: [other('33333333-3333-4333-8333-333333333333', 'Eve'), other('44444444-4444-4444-8444-444444444444', 'Fay')] }), { status: 200 });
    await open(frag('move,solo'));
    expect(container.querySelector('[data-testid=quick-agent-fixed]')).toBeNull();
    expect(text()).not.toContain('Eve · Claude Code'); // the card's fixed line never names a different agent
    expect(calls.some((c) => c.url.endsWith('/api/desktop/recipes'))).toBe(true);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('self-QA: the move answers «the agent is gone / left the project» → the recipe page with its reasons, not the same card with a dead start', async () => {
    for (const code of ['agent_not_found', 'agent_not_in_project']) {
      confirmNow = () => new Response(JSON.stringify({ error: { code } }), { status: code === 'agent_not_found' ? 404 : 422 });
      calls.length = 0;
      await open(frag('move,solo'));
      await act(async () => { start()!.click(); });
      for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(container.querySelector('[data-testid=quick-agent-fixed]')).toBeNull();
      expect(calls.some((c) => c.url.endsWith('/api/desktop/recipes'))).toBe(true);
      expect(calls.filter((c) => c.method === 'POST').length).toBe(1); // the one move; nothing else was posted
      await act(async () => { root.render(<div />); });
    }
  });

  it('self-QA: a network failure on the move → «연결이 끊겼어요» whose [다시 시도] posts the MOVE again (never confirm-solo, never nothing)', async () => {
    let first = true;
    confirmNow = () => { if (first) { first = false; throw new TypeError('network'); } return confirmOk(); };
    await open(frag('move,solo'));
    await act(async () => { start()!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(text()).toContain('연결이 끊겼어요');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === '다시 시도') as HTMLButtonElement;
    await act(async () => { retry.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(posts.filter((u) => u === '/api/desktop/setup-codes/confirm').length).toBe(2);
    expect(posts.some((u) => u.includes('confirm-solo'))).toBe(false);
    expect((calls.filter((c) => c.method === 'POST')[1]!.body as { roles: unknown[] }).roles).toEqual([{ role: 'move', agent_id: AGENT }]);
  });

  it('self-QA: a list read that never answers → after the limit the recipe page takes over (no spinner for good)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      agents = () => new Response(new ReadableStream({ start() { /* the body never finishes */ } }), { status: 200 });
      window.location.hash = frag('move,solo');
      await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopSetupEntry /></NextIntlClientProvider>); });
      for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
      expect(calls.some((c) => c.url.endsWith('/api/desktop/recipes'))).toBe(false); // still reading
      await act(async () => { vi.advanceTimersByTime(ATTACHABLE_READ_LIMIT_MS + 1); });
      for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
      expect(calls.some((c) => c.url.endsWith('/api/desktop/recipes'))).toBe(true);
      expect(container.querySelector('[data-testid=quick-agent-fixed]')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('an app from before (cannot move) → the recipe page as before (the address\'s agent= is its preselect)', async () => {
    await open(frag('solo'));
    expect(container.querySelector('[data-testid=quick-agent-fixed]')).toBeNull();
    expect(container.querySelector('[data-testid=quick-card]')).toBeNull();
  });

  it('a person who cannot move agents (not owner/admin) → no card, no list read', async () => {
    ctx.mockReturnValue({ projectId: PROJ, userName: 'x', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'member' }], projectMemberships: [] });
    await open(frag('move,solo'));
    expect(container.querySelector('[data-testid=quick-agent-fixed]')).toBeNull();
    expect(calls.some((c) => c.url.includes('/api/desktop/setup/agents'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/api/desktop/recipes'))).toBe(true); // the recipe page took over — not a loading card that never ends
  });
});
