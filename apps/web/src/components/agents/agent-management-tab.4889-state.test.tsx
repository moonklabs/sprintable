// @vitest-environment jsdom
//
// story 4889 (UI-6 · W1) — the team list row shows the agent's LIVE state (the same one read as the DM strip and the Today list), in the strip's own words, as a ds StatusLabel.
// An agent with no session keeps the row as it was. Reverting the mark makes this go red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { AgentStateRow } from '@/lib/agent-state-list';

const { statesRef } = vi.hoisted(() => ({ statesRef: { current: [] as AgentStateRow[] } }));
vi.mock('@/hooks/use-agent-states', () => ({ useAgentStates: () => ({ rows: statesRef.current, loaded: true, readAt: Date.now() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const row = (agent_id: string, extra: Partial<AgentStateRow> = {}): AgentStateRow => ({
  agent_id, agent_name: agent_id, conversation_id: null, conversation_project_id: null, bound_setup_id: null, bound_device_name: null,
  setup_id: 's1', device_name: 'Mac', state: 'running', activity: null, state_at: null, limit: null, first_screen: null, ...extra,
});

beforeEach(() => { statesRef.current = []; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

function stubFetch() {
  const agents = [
    { id: 'a-work', name: '일하는 에이전트', role: 'member', is_active: true },
    { id: 'a-hand', name: '손 필요 에이전트', role: 'member', is_active: true },
    { id: 'a-none', name: '세션 없는 에이전트', role: 'member', is_active: true },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { role: 'admin' } }) };
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url.startsWith('/api/team-members?')) return { ok: true, json: async () => ({ data: agents }) };
    return { ok: false, json: async () => null };
  }));
}
async function mount() {
  const { AgentManagementTab } = await import('./agent-management-tab');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentManagementTab /></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const mark = (id: string) => container.querySelector(`[data-testid="agent-state-mark"][data-agent-id="${id}"]`);

describe('팀 목록 행의 실시간 상태(story 4889 · W1)', () => {
  it('⭐세션이 있는 에이전트 행은 상태를 ds StatusLabel로 단다(글은 DM 띠의 낱말 표) — 일하는 중 · 내 손이 필요(권한) · 세션 없는 에이전트는 그대로(표시 없음)', async () => {
    statesRef.current = [row('a-work', { activity: 'working' }), row('a-hand', { activity: 'waiting_permission' })];
    stubFetch();
    await mount();
    expect(mark('a-work')?.getAttribute('data-status')).toBe('working');
    expect(mark('a-work')?.textContent).toBe(koMessages.chats.agentSession.state.working);
    expect(mark('a-hand')?.getAttribute('data-status')).toBe('needs-hand');
    expect(mark('a-hand')?.textContent).toBe(koMessages.chats.agentSession.state.waiting_permission);
    expect(mark('a-none')).toBeNull();
    expect(container.textContent).toContain('세션 없는 에이전트'); // the row itself is still there
  });

  it('⭐배선: 첫 화면 질문(터미널이 묻는 중)은 «일하는 중»이어도 내 손(needs-hand) · 앱이 다시 보는 한도(looks)는 손이 아니라 쉼(idle) — Today 목록과 같은 판정', async () => {
    statesRef.current = [
      row('a-work', { activity: 'working', first_screen: { ask: 'trust' } }),
      row('a-hand', { activity: 'waiting_input', limit: { self_resume: 'maybe', looks: true } }),
    ];
    stubFetch();
    await mount();
    expect(mark('a-work')?.getAttribute('data-status')).toBe('needs-hand');
    expect(mark('a-work')?.textContent).toBe(koMessages.chats.agentSession.state.waiting_first_screen);
    expect(mark('a-hand')?.getAttribute('data-status')).toBe('idle');
  });

  it('상태 읽기가 아직 비었거나 이 에이전트의 줄이 없으면 표시 없이 목록은 그대로 선다', async () => {
    stubFetch();
    await mount();
    expect(container.querySelectorAll('[data-testid="agent-state-mark"]').length).toBe(0);
    expect(container.textContent).toContain('일하는 에이전트');
  });

  it('⭐끝난 세션(«끝» = stopped)은 세션이 없는 것과 같다 — 표시를 안 단다. 연결 끊김 · 오류 · 손 필요 · 일하는 중 · 쉼은 그대로 단다(PO 11-11)', async () => {
    statesRef.current = [row('a-work', { state: 'stopped', activity: null }), row('a-hand', { state: 'unknown', activity: null })];
    stubFetch();
    await mount();
    expect(mark('a-work')).toBeNull(); // ended: no mark (the row itself stays)
    expect(container.textContent).toContain('일하는 에이전트');
    expect(mark('a-hand')?.getAttribute('data-status')).toBe('offline'); // «연결 끊김 · 상태 모름» still shown
    expect(mark('a-hand')?.textContent).toBe(koMessages.chats.agentSession.state.unknown);
  });

  it('⭐세션 줄이 state=null이면(컴퓨터에 묶였지만 아직 안 돎) 표시를 만들어 내지 않는다', async () => {
    statesRef.current = [row('a-work', { state: null, activity: null, bound_setup_id: 'b1', bound_device_name: 'Mac' })];
    stubFetch();
    await mount();
    expect(mark('a-work')).toBeNull();
  });
});

// story 4889 — the hand-drawn `animate-pulse` bars of this list became the ds Skeleton group (PO 11-11: swapped where a screen is rebuilt): ONE spoken «불러오는 중…», bars decorative.
describe('팀 목록 불러오는 중(story 4889)', () => {
  it('⭐불러오는 동안 ds SkeletonGroup(role=status · 이름 «불러오는 중…» 하나) + 장식 막대 셋 — 손으로 그린 animate-pulse 막대 아님', async () => {
    let release!: (v: unknown) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => (typeof url === 'string' && url.startsWith('/api/team-members?')
      ? new Promise((r) => { release = r; })
      : Promise.resolve({ ok: true, json: async () => ({ data: url === '/api/me' ? { role: 'admin' } : [] }) }))));
    const { AgentManagementTab } = await import('./agent-management-tab');
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentManagementTab /></NextIntlClientProvider>); });
    const group = container.querySelector('[data-testid="agent-list-loading"]')!;
    expect(group.getAttribute('role')).toBe('status');
    expect(group.getAttribute('aria-label')).toBe(koMessages.common.loading);
    expect(group.querySelectorAll('[data-slot="ds-skeleton"]').length).toBe(3);
    expect(group.querySelector('.animate-pulse.bg-muted')).toBeNull();
    await act(async () => { release({ ok: true, json: async () => ({ data: [] }) }); await Promise.resolve(); });
  });
});
