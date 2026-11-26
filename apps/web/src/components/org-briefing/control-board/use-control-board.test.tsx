// @vitest-environment jsdom
/**
 * story 5033 (C3) — what the board reads and writes. The write path is the access calls that already exist (POST / DELETE `/api/projects/{pid}/access…`): the body, the url, who may press (a viewer that cannot read the
 * placement gets no write at all), one press = one write, and a refused or lost write is SAID (never shown as done).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentStateRow } from '@/lib/agent-state-list';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), states: { rows: [] as AgentStateRow[], loaded: true, readAt: 1 } }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('@/hooks/use-agent-states', () => ({ useAgentStates: () => mocks.states }));

import { parseOverviewEpics, useControlBoard } from './use-control-board';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P1 = { id: 'p1', name: 'Alpha' };
const P2 = { id: 'p2', name: 'Beta' };
const ANN = { id: 'a1', name: 'Ann' };

function stateRow(id: string, name: string): AgentStateRow {
  return { agent_id: id, agent_name: name, conversation_id: null, conversation_project_id: null, bound_setup_id: null, bound_device_name: null, setup_id: null, device_name: null, state: 'idle', activity: 'idle', state_at: null, limit: null, first_screen: null };
}
const ok = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;
const refuse = (status: number) => ({ ok: false, status, json: async () => ({}) }) as Response;

interface World { matrix: Response | (() => Response); post?: Response | (() => Promise<Response>); del?: Response }
let calls: Array<{ url: string; method: string; body?: string }>;
function world(w: World) {
  calls = [];
  mocks.fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (method === 'POST') { const p = w.post ?? ok({ id: 'rNew' }); return typeof p === 'function' ? p() : p; }
    if (method === 'DELETE') return w.del ?? ok(null);
    if (url === '/api/projects') return ok([P1, P2]);
    if (url === '/api/dashboard/overview') return ok({ project_status: { epics: [{ epic_id: 'e1', title: 'E', status: 'active', total: 4, done: 1, project_id: 'p1' }] } });
    if (url === '/api/team-members?type=agent') return ok([{ id: 'a1', name: 'Ann', is_active: true, runtime_type: 'claude-code' }, { id: 'sys', name: 'Sys', is_active: true, runtime_type: 'system-publisher' }, { id: 'off', name: 'Off', is_active: false }]);
    if (url === '/api/agents/access-matrix') return typeof w.matrix === 'function' ? w.matrix() : w.matrix;
    throw new Error(`unexpected ${method} ${url}`);
  });
}

let container: HTMLDivElement;
let root: Root;
const probe: { api: ReturnType<typeof useControlBoard> } = { api: null as never };
function Probe() { const board = useControlBoard(); useEffect(() => { probe.api = board; }); return null; }
beforeEach(() => {
  mocks.states = { rows: [stateRow('a1', 'Ann'), stateRow('sys', 'Sys'), stateRow('off', 'Off')], loaded: true, readAt: 1 };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); mocks.fetchWithAuth.mockReset(); });

async function mount() {
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const writes = () => calls.filter((c) => c.method !== 'GET');
const MATRIX_ANN_P1 = () => ok([{ record_id: 'r1', agent_member_id: 'a1', project_id: 'p1' }]);

describe('reading', () => {
  it('⭐reads the projects, the epics (with their project), the agents and the placement — and shows only active, non-system agents', async () => {
    world({ matrix: MATRIX_ANN_P1 });
    await mount();
    expect(probe.api.loaded).toBe(true);
    expect(probe.api.projects).toEqual([P1, P2]);
    expect(probe.api.epics).toEqual([{ projectId: 'p1', status: 'active', total: 4, done: 1 }]);
    expect(probe.api.agents.map((a) => a.agent_name)).toEqual(['Ann']);
    expect(probe.api.grants).toEqual({ 'a1::p1': 'r1' });
    expect(writes()).toEqual([]); // mounting writes nothing
  });
  it('⭐a 403 on the placement (not an org admin) → grants = null (read only), the rest still shows', async () => {
    world({ matrix: refuse(403) });
    await mount();
    expect(probe.api.loaded).toBe(true);
    expect(probe.api.grants).toBeNull();
    expect(probe.api.projects.length).toBe(2);
  });
  it('parseOverviewEpics: a plain or enveloped answer, a missing project_id = null, a malformed entry is skipped', () => {
    const epics = [{ status: 'active', total: 2, done: 1, project_id: 'p1' }, { status: 'active', total: 3, done: 0 }, 'junk', { total: 1 }];
    expect(parseOverviewEpics({ data: { project_status: { epics } } })).toEqual([{ projectId: 'p1', status: 'active', total: 2, done: 1 }, { projectId: null, status: 'active', total: 3, done: 0 }]);
    expect(parseOverviewEpics({ project_status: { epics } }).length).toBe(2);
    expect(parseOverviewEpics(null)).toEqual([]);
  });
});

describe('writing — the same two calls the access screens already make', () => {
  it('⭐place = ONE POST /api/projects/{pid}/access with {member_id, org_member_id:null, permission:granted}; the new record id is kept', async () => {
    world({ matrix: MATRIX_ANN_P1 });
    await mount();
    await act(async () => { await probe.api.place(ANN, P2); });
    expect(writes()).toEqual([{ url: '/api/projects/p2/access', method: 'POST', body: JSON.stringify({ member_id: 'a1', org_member_id: null, permission: 'granted' }) }]);
    expect(probe.api.grants).toEqual({ 'a1::p1': 'r1', 'a1::p2': 'rNew' });
    expect(probe.api.outcome).toEqual({ kind: 'placed', agentName: 'Ann', projectName: 'Beta' });
  });
  it('⭐takeOut = ONE DELETE /api/projects/{pid}/access/{record} (the record the placement read gave); the grant leaves the map', async () => {
    world({ matrix: MATRIX_ANN_P1 });
    await mount();
    await act(async () => { await probe.api.takeOut(ANN, P1); });
    expect(writes()).toEqual([{ url: '/api/projects/p1/access/r1', method: 'DELETE', body: undefined }]);
    expect(probe.api.grants).toEqual({});
    expect(probe.api.outcome).toEqual({ kind: 'tookOut', agentName: 'Ann', projectName: 'Alpha' });
  });
  it('⭐a viewer who cannot read the placement gets NO write (nothing is sent from a guess)', async () => {
    world({ matrix: refuse(403) });
    await mount();
    await act(async () => { await probe.api.place(ANN, P2); await probe.api.takeOut(ANN, P1); });
    expect(writes()).toEqual([]);
  });
  it('⭐one press = one write: a second press while the first is in flight is ignored', async () => {
    let release!: (r: Response) => void;
    world({ matrix: MATRIX_ANN_P1, post: () => new Promise<Response>((r) => { release = r; }) as never });
    mocks.fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (init?.method === 'POST') return new Promise<Response>((r) => { release = r; });
      if (url === '/api/projects') return ok([P1, P2]);
      if (url === '/api/dashboard/overview') return ok({ project_status: { epics: [] } });
      if (url === '/api/team-members?type=agent') return ok([{ id: 'a1', name: 'Ann', is_active: true }]);
      return MATRIX_ANN_P1();
    });
    await mount();
    let first!: Promise<void>;
    await act(async () => { first = probe.api.place(ANN, P2); });
    await act(async () => { await probe.api.place(ANN, P2); });
    expect(writes().length).toBe(1);
    await act(async () => { release(ok({ id: 'rNew' })); await first; });
    expect(writes().length).toBe(1);
  });
  it('⭐a refused write (403) is SAID and the grants stay as they were', async () => {
    world({ matrix: MATRIX_ANN_P1, post: refuse(403) });
    await mount();
    await act(async () => { await probe.api.place(ANN, P2); });
    expect(probe.api.outcome).toEqual({ kind: 'failed', agentName: 'Ann', projectName: 'Beta' });
    expect(probe.api.grants).toEqual({ 'a1::p1': 'r1' });
  });
  it('⭐a lost network is SAID too (never shown as done)', async () => {
    world({ matrix: MATRIX_ANN_P1, post: () => Promise.reject(new TypeError('network')) });
    await mount();
    await act(async () => { await probe.api.place(ANN, P2); });
    expect(probe.api.outcome?.kind).toBe('failed');
    expect(probe.api.grants).toEqual({ 'a1::p1': 'r1' });
  });
  it('a 409 (already placed elsewhere) re-reads the placement instead of saying «failed»; placing an already-placed agent sends nothing', async () => {
    world({ matrix: MATRIX_ANN_P1, post: refuse(409) });
    await mount();
    const before = calls.length;
    await act(async () => { await probe.api.place(ANN, P2); });
    expect(probe.api.outcome).toBeNull();
    expect(calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/projects/p2/access', 'GET /api/agents/access-matrix']);
    await act(async () => { await probe.api.place(ANN, P1); }); // already placed in p1
    expect(writes().length).toBe(1);
  });
});
