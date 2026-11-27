// @vitest-environment jsdom
//
// story 5036 (C6 · PO 11-27): the setup's END (someone who did not come through the first-run line — no mark) opens the PROJECT'S CHANNEL of the project the agent really sits in: the start's direct room names that project.
// Anything that cannot be read opens the start's own conversation, exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { ctx } = vi.hoisted(() => ({ ctx: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx() }));
vi.mock('@/lib/ee', () => ({ isEEEnabled: () => false }));

import { SetupProgressView } from './desktop-setup-progress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS = {
  setup_id: 's-1', device_name: 'Mac', state: 'handed_over', recipe_name: null, recipe: null, work_item_id: null, setup_kind: 'solo', conversation_id: 'dm-1',
  members: [{ stage: null, role: null, member_id: 'm-1', kind: 'agent', runtime: 'claude', name: 'Claude Code' }],
  signals: { tools_connected: [], first_task_handed_at: null, first_result_at: null, workdir_fallback_at: null, blocked: null },
};
let container: HTMLDivElement;
let root: Root;
let room: () => Response;
let rooms: () => Response;
let calls: string[];

async function end(): Promise<ReturnType<typeof vi.fn>> {
  ctx.mockReturnValue({ projectId: 'tab-project', currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }], projectMemberships: [] });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.includes('/api/desktop/setups/')) return new Response(JSON.stringify(STATUS), { status: 200 });
    if (url === '/api/conversations/dm-1') return room();
    if (url.startsWith('/api/conversations?')) return rooms();
    return new Response('{}', { status: 404 });
  }));
  const assign = vi.fn();
  const real = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...real, pathname: real.pathname, search: real.search, hash: real.hash, assign } });
  try {
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SetupProgressView setupId="s-1" recipeName="" /></NextIntlClientProvider>); });
    for (let i = 0; i < 16; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  } finally { Object.defineProperty(window, 'location', { configurable: true, value: real }); }
  return assign;
}

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  calls = []; sessionStorage.clear();
  room = () => new Response(JSON.stringify({ id: 'dm-1', project_id: 'agent-project' }), { status: 200 });
  rooms = () => new Response(JSON.stringify({ data: [{ id: 'dm-x' }, { id: 'chan-1', is_project_channel: true }] }), { status: 200 });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('[SID:5036] the setup end opens the project\'s channel', () => {
  it('no mark: the channel of the project the agent sits in (the start\'s room names it — NOT the tab\'s project) — once', async () => {
    const assign = await end();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]![0])).toContain('/chats/chan-1');
    const list = calls.find((u) => u.startsWith('/api/conversations?'))!;
    expect(list).toContain('project_id=agent-project');
    expect(list).not.toContain('tab-project');
  });

  it.each([
    ['the start\'s room cannot be read', () => { room = () => new Response('{}', { status: 500 }); }],
    ['the room names no project', () => { room = () => new Response(JSON.stringify({ id: 'dm-1' }), { status: 200 }); }],
    ['the channel list cannot be read', () => { rooms = () => new Response('{}', { status: 500 }); }],
    ['the project has no channel (an older server)', () => { rooms = () => new Response(JSON.stringify({ data: [{ id: 'dm-x' }] }), { status: 200 }); }],
  ])('%s → the start\'s own conversation, exactly as before (never a dead end)', async (_n, arrange) => {
    arrange();
    const assign = await end();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]![0])).toContain('/chats/dm-1');
  });
});


describe('[SID:5036] a late room lookup does not take the person off a screen that has moved on (codex)', () => {
  it('the page is gone when the answer comes → no navigation (reverted → the old promise still assigns /chats/…)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    room = () => { throw new Error('replaced below'); };
    ctx.mockReturnValue({ projectId: 'tab-project', currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }], projectMemberships: [] });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url.includes('/api/desktop/setups/')) return new Response(JSON.stringify(STATUS), { status: 200 });
      if (url === '/api/conversations/dm-1') { await gate; return new Response(JSON.stringify({ id: 'dm-1', project_id: 'agent-project' }), { status: 200 }); }
      if (url.startsWith('/api/conversations?')) return rooms();
      return new Response('{}', { status: 404 });
    }));
    const assign = vi.fn();
    const real = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...real, pathname: real.pathname, search: real.search, hash: real.hash, assign } });
    try {
      await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SetupProgressView setupId="s-1" recipeName="" /></NextIntlClientProvider>); });
      for (let i = 0; i < 12 && !calls.includes('/api/conversations/dm-1'); i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(calls).toContain('/api/conversations/dm-1'); // the lookup is in flight
      await act(async () => { root.unmount(); }); // the screen goes away…
      root = createRoot(container);
      release(); // …and the answer comes after
      for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    } finally { Object.defineProperty(window, 'location', { configurable: true, value: real }); }
    expect(assign).not.toHaveBeenCalled();
  });
});
