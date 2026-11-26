// @vitest-environment jsdom
/**
 * story 5033 (C3) — the CONTAINER (`ControlBoard`: the reads · the derive · the hands wired together), not just its view (codex 5958: a view-only test stays green when the permissions, the reads, the writes or the
 * system-publisher filter are reverted). Only the network (`fetchWithAuth`) and the agents' state read are made here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import type { AgentStateRow } from '@/lib/agent-state-list';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), states: { rows: [] as AgentStateRow[], loaded: true, readAt: 1, failed: false } }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('@/hooks/use-agent-states', () => ({ useAgentStates: () => mocks.states }));

import { ControlBoard } from './control-board';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;
const refuse = (status: number) => ({ ok: false, status, json: async () => ({}) }) as Response;
function stateRow(id: string, name: string): AgentStateRow {
  return { agent_id: id, agent_name: name, conversation_id: null, conversation_project_id: null, bound_setup_id: null, bound_device_name: null, setup_id: null, device_name: null, state: 'working', activity: 'working', state_at: null, limit: null, first_screen: null };
}

let calls: Array<{ url: string; method: string; body?: string }>;
let net: { matrix: () => Response; members: () => Response };
function wire() {
  calls = [];
  net = {
    matrix: () => ok([{ record_id: 'r1', agent_member_id: 'a1', project_id: 'p1' }]),
    members: () => ok([{ id: 'a1', name: 'Ann', is_active: true, runtime_type: 'claude-code' }, { id: 'a2', name: 'Bo', is_active: true, runtime_type: 'claude-code' }, { id: 'sys', name: 'Sys', is_active: true, runtime_type: 'system-publisher' }]),
  };
  mocks.fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (method === 'POST') return ok({ id: 'rNew' });
    if (method === 'DELETE') return ok(null);
    if (url === '/api/projects') return ok([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }]);
    if (url === '/api/dashboard/overview') return ok({ project_status: { epics: [{ status: 'active', total: 10, done: 4, project_id: 'p1' }] } });
    if (url === '/api/team-members?type=agent') return net.members();
    if (url === '/api/agents/access-matrix') return net.matrix();
    throw new Error(`unexpected ${method} ${url}`);
  });
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mocks.states = { rows: [stateRow('a1', 'Ann'), stateRow('a2', 'Bo'), stateRow('sys', 'Sys')], loaded: true, readAt: 1, failed: false };
  wire();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); mocks.fetchWithAuth.mockReset(); });

async function mount() {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ControlBoard needsHandByProject={{ p2: 2 }} /></NextIntlClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[];
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
async function press(el: Element) {
  await act(async () => { for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })); });
}
const faceNames = (zone: string) => qa(`${zone} [data-testid="control-face"]`).map((f) => f.getAttribute('data-agent-id'));

describe('ControlBoard (container)', () => {
  it('⭐reads → one line per project with its progress and «확인 필요»; the faces of the agents the roster allows stand where the placement says; the system publisher is nowhere', async () => {
    await mount();
    expect(qa('[data-testid="control-channel-name"]').map((e) => e.textContent)).toEqual(['Alpha', 'Beta']);
    expect(qa('[data-testid="control-channel-progress"]')[0]!.textContent).toContain('4/10');
    expect(qa('[data-testid="control-channel-needs-hand"]').map((e) => e.textContent)).toEqual(['확인 필요 2']);
    expect(faceNames('[data-drop-id="channel:p1"]')).toEqual(['a1']);
    expect(faceNames('[data-testid="control-bench"]')).toEqual(['a2']);
    expect(qa('[data-agent-id="sys"]').length, 'the system publisher is never on the board').toBe(0);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]); // reading writes nothing
  });
  it('⭐a 403 on the placement → read only: faces and states, no handle, no menu', async () => {
    net.matrix = () => refuse(403);
    await mount();
    expect(qa('[data-testid="control-face"]').length).toBe(2);
    expect(qa('[data-testid="control-face-handle"], [data-testid="control-face-menu"]').length).toBe(0);
  });
  it('⭐the roster unreadable → an error with a retry, no board, no controls; the retry reads again', async () => {
    net.members = () => refuse(500);
    await mount();
    expect(q('[data-testid="control-board-error"]')).not.toBeNull();
    expect(q('[data-testid="control-board"]')).toBeNull();
    expect(qa('[data-testid="control-face-menu"]').length).toBe(0);
    net.members = () => ok([{ id: 'a1', name: 'Ann', is_active: true, runtime_type: 'claude-code' }]);
    await press(q('[data-testid="control-board-error"] button')!);
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(q('[data-testid="control-board"]')).not.toBeNull();
    expect(q('[data-testid="control-board-error"]')).toBeNull();
  });
  it('⭐the menu of a benched face → «Alpha에 넣기» sends the one POST and the face moves into Alpha', async () => {
    await mount();
    await press(q('[data-testid="control-bench"] [data-testid="control-face-menu"]')!);
    expect(menuItems().map((m) => m.textContent)).toEqual(['Alpha에 넣기', 'Beta에 넣기']);
    await press(menuItems()[0]!);
    await act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([{ url: '/api/projects/p1/access', method: 'POST', body: JSON.stringify({ member_id: 'a2', org_member_id: null, permission: 'granted' }) }]);
    expect(faceNames('[data-drop-id="channel:p1"]').sort()).toEqual(['a1', 'a2']);
    expect(faceNames('[data-testid="control-bench"]')).toEqual([]);
    expect(q('[data-testid="control-outcome"]')!.textContent).toBe('Bo를 Alpha에 넣었어요.');
  });
  it('⭐the menu of a placed face → «Alpha에서 빼기» sends the one DELETE of its record and the face goes to the lane', async () => {
    await mount();
    await press(q('[data-drop-id="channel:p1"] [data-testid="control-face-menu"]')!);
    await press(menuItems().find((m) => m.textContent === 'Alpha에서 빼기')!);
    await act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([{ url: '/api/projects/p1/access/r1', method: 'DELETE', body: undefined }]);
    expect(faceNames('[data-drop-id="channel:p1"]')).toEqual([]);
    expect(faceNames('[data-testid="control-bench"]').sort()).toEqual(['a1', 'a2']);
  });
  it('the filter narrows the board to one project and the lane to «not in that project» (no request is made by filtering)', async () => {
    await mount();
    const before = calls.length;
    const select = q('select[data-testid="control-filter"], [data-testid="control-filter"] select') as HTMLSelectElement;
    await act(async () => { select.value = 'p2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(qa('[data-testid="control-channel-name"]').map((e) => e.textContent)).toEqual(['Beta']);
    expect(faceNames('[data-testid="control-bench"]').sort()).toEqual(['a1', 'a2']);
    expect(calls.length).toBe(before);
  });
});
