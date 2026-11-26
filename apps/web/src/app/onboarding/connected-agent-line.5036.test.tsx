// @vitest-environment jsdom
/**
 * story 5036 (next PR · PO 11-26) — an agent that connected through the key way BEFORE the page was opened (a reload · coming back) is not drawn as «not
 * connected»: one line over the three ways says so and carries the way to the first chat (step ③). It asks what the key way's own panel asks — the project's
 * agents, newest first, their verification status over the hosted transport. It draws nothing while it does not know (an unreadable answer is never a line
 * that says «none»); the three ways stand as they are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

type Reply = { ok: boolean; status?: number; body?: unknown };
const routes = new Map<string, () => Reply>();
const calls: string[] = [];

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async (url: string) => {
    calls.push(url);
    const h = routes.get(url.split('?')[0]);
    const r = h ? h() : { ok: false, status: 404, body: {} };
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body } as Response;
  }),
}));

import { ConnectedAgentLine } from './connected-agent-line';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const line = koMessages.onboarding.line;
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = async () => { for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); }); };

const status = (verified: boolean): Reply => ({
  ok: true,
  body: { data: { verified, rail: [{ state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'done' }, { state: 'mcp_reachable', status: verified ? 'done' : 'active' }, { state: 'verified', status: verified ? 'done' : 'pending' }] } },
});

const tree = (projectId: string, onGo: (id: string) => void) => (
  <NextIntlClientProvider locale="ko" messages={koMessages}><ConnectedAgentLine projectId={projectId} onGo={onGo} /></NextIntlClientProvider>
);

async function mount(onGo: (id: string) => void = () => undefined) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><ConnectedAgentLine projectId="proj-1" onGo={onGo} /></NextIntlClientProvider>);
  });
  await flush();
}

beforeEach(() => { routes.clear(); calls.length = 0; });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('the line for an agent that connected before the page was opened', () => {
  it('a verified agent of the project → the line (its name · the way to step ③ with THAT agent); the list asked is the project\'s agents', async () => {
    routes.set('/api/team-members', () => ({ ok: true, body: { data: [{ id: 'agent-old', name: '옛 에이전트' }, { id: 'agent-new', name: '내 에이전트' }] } }));
    routes.set('/api/agents/agent-new/verification-status', () => status(true));
    routes.set('/api/agents/agent-old/verification-status', () => status(false));
    const onGo = vi.fn();
    await mount(onGo);
    expect(q('connect-branches-connected')).not.toBeNull();
    expect(q('connect-branches-connected')!.textContent).toContain(line.connectedBefore);
    expect(q('connect-branches-connected-name')!.textContent).toBe('내 에이전트');
    expect(q('connect-branches-connected-go')!.textContent).toBe(line.connectedGo);
    expect(calls[0]).toContain('/api/team-members?project_id=proj-1&type=agent');
    expect(calls.some((c) => c.includes('/api/agents/agent-new/verification-status?transport=http'))).toBe(true);
    await act(async () => { q('connect-branches-connected-go')!.click(); });
    expect(onGo).toHaveBeenCalledTimes(1);
    expect(onGo).toHaveBeenCalledWith('agent-new'); // reverted (the go carries no agent / the wrong one) → red
  });

  it('the newest agent is asked first and the asking stops at the first verified one', async () => {
    routes.set('/api/team-members', () => ({ ok: true, body: { data: [{ id: 'a1', name: 'a' }, { id: 'a2', name: 'b' }, { id: 'a3', name: 'c' }] } }));
    routes.set('/api/agents/a3/verification-status', () => status(true));
    routes.set('/api/agents/a2/verification-status', () => status(true));
    routes.set('/api/agents/a1/verification-status', () => status(true));
    await mount();
    expect(calls.filter((c) => c.includes('verification-status')).map((c) => c.split('/')[3])).toEqual(['a3']);
  });

  it('no agent is verified → no line (the three ways stand as they are)', async () => {
    routes.set('/api/team-members', () => ({ ok: true, body: { data: [{ id: 'a1', name: 'a' }] } }));
    routes.set('/api/agents/a1/verification-status', () => status(false));
    await mount();
    expect(q('connect-branches-connected')).toBeNull();
  });

  it.each([
    ['the agent list is a 500', { ok: false, status: 500, body: {} }],
    ['the agent list is not a list', { ok: true, body: { data: { id: 'x' } } }],
    ['the agent list is empty', { ok: true, body: { data: [] } }],
  ] as const)('%s → no line, and no status is asked for an agent that is not there', async (_n, listReply) => {
    routes.set('/api/team-members', () => listReply as Reply);
    await mount();
    expect(q('connect-branches-connected')).toBeNull();
    expect(calls.filter((c) => c.includes('verification-status'))).toEqual([]);
  });

  it('a status that cannot be read is not «verified» (an unreadable answer never draws the line) — the next agent is still asked', async () => {
    routes.set('/api/team-members', () => ({ ok: true, body: { data: [{ id: 'a1', name: 'a' }, { id: 'a2', name: 'b' }] } }));
    routes.set('/api/agents/a2/verification-status', () => ({ ok: false, status: 500, body: {} }));
    routes.set('/api/agents/a1/verification-status', () => status(true));
    await mount();
    expect(q('connect-branches-connected-name')!.textContent).toBe('a');
  });

  it('codex 5036: a rail with a null in it is not «verified» and does not end the search — the next (older) agent is still asked', async () => {
    routes.set('/api/team-members', () => ({ ok: true, body: { data: [{ id: 'a1', name: 'older' }, { id: 'a2', name: 'newer' }] } }));
    routes.set('/api/agents/a2/verification-status', () => ({ ok: true, body: { data: { rail: [null, { state: 'waiting', status: 'done' }] } } }));
    routes.set('/api/agents/a1/verification-status', () => status(true));
    await mount();
    // reverted (`s.state` on the null throws and the outer catch ends the search) → no line here
    expect(q('connect-branches-connected-name')!.textContent).toBe('older');
  });

  it('codex 5036: the project changes → the line of the project before is gone (never a button to another project\'s agent)', async () => {
    routes.set('/api/team-members', () => ({ ok: true, body: { data: [{ id: 'a1', name: 'of project 1' }] } }));
    routes.set('/api/agents/a1/verification-status', () => status(true));
    await mount();
    expect(q('connect-branches-connected-name')!.textContent).toBe('of project 1');
    routes.set('/api/team-members', () => ({ ok: true, body: { data: [] } })); // project 2 has no agent
    await act(async () => { root.render(tree('proj-2', () => undefined)); });
    await flush();
    // reverted (`found` is kept across projects) → the old card stays
    expect(q('connect-branches-connected')).toBeNull();
  });

  it('an agent with no name draws the line without a name', async () => {
    routes.set('/api/team-members', () => ({ ok: true, body: { data: [{ id: 'a1' }] } }));
    routes.set('/api/agents/a1/verification-status', () => status(true));
    await mount();
    expect(q('connect-branches-connected')).not.toBeNull();
    expect(q('connect-branches-connected-name')).toBeNull();
  });
});
