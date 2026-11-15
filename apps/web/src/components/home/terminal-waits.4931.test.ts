// story #4931 — an agent that stands at a question in a Mac terminal waits for a person. The home counts it only when the session runs on the READER'S OWN computer (the server's `device_is_mine`).
import { describe, expect, it } from 'vitest';
import type { AgentStateRow } from '@/lib/agent-state-list';
import { deriveHome, type HomeInput } from './derive-home';
import { toTerminalWaits } from './terminal-waits';

const row = (over: Partial<AgentStateRow> = {}): AgentStateRow => ({
  agent_id: 'a1', agent_name: '에이전트 하나', conversation_id: 'c1', conversation_project_id: 'p1',
  bound_setup_id: null, bound_device_name: null, setup_id: 's1', device_name: '맥 하나',
  state: 'working', activity: 'working', state_at: '2026-11-14T05:00:00Z', limit: null,
  first_screen: { ask: 'trust' }, device_is_mine: true, ...over,
});

describe('toTerminalWaits — 내 컴퓨터에서 터미널 물음에 서 있는 에이전트만', () => {
  it('기다림 0 · 1 · 여럿 — 수는 내 기기의 기다림만', () => {
    expect(toTerminalWaits([])).toEqual([]);
    expect(toTerminalWaits([row()]).map((w) => w.agentId)).toEqual(['a1']);
    const many = toTerminalWaits([row(), row({ agent_id: 'a2', activity: 'idle', state: 'idle' }), row({ agent_id: 'a3', activity: 'starting', state: 'starting', first_screen: { ask: 'mcp_many' } })]);
    expect(many.map((w) => w.agentId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('⭐남의 기기가 기다리면 수 0 — 그 맥 앞 사람만 답할 수 있다(«에이전트 상태»에만 남는다)', () => {
    expect(toTerminalWaits([row({ device_is_mine: false })])).toEqual([]);
  });

  it('서버가 «내 기기인가»를 말하지 않으면(옛 서버) 세지 않는다 — 모르는 것을 «내 것»으로 세지 않는다', () => {
    const r = row(); delete r.device_is_mine;
    expect(toTerminalWaits([r])).toEqual([]);
  });

  it('물음이 서 있지 않으면(first_screen 없음) · 권한 물음/멈춤이면 세지 않는다', () => {
    expect(toTerminalWaits([row({ first_screen: null })])).toEqual([]);
    expect(toTerminalWaits([row({ activity: 'waiting_permission', state: 'waiting_permission' })])).toEqual([]);
    expect(toTerminalWaits([row({ activity: 'stopped', state: 'stopped' })])).toEqual([]);
  });

  it('행이 에이전트 이름 · 기기 이름 · 그 에이전트 대화를 들고 있다', () => {
    expect(toTerminalWaits([row()])[0]).toEqual({ agentId: 'a1', agentName: '에이전트 하나', deviceName: '맥 하나', since: '2026-11-14T05:00:00Z', conversationId: 'c1', conversationProjectId: 'p1' });
  });
});

describe('deriveHome — 터미널 기다림이 «손 필요» 행 · 수 · 배지에 든다', () => {
  const base = (waits: HomeInput['terminalWaits']): HomeInput => ({
    snapshot: { needsMe: [], agentProgress: [] }, notifications: [], stories: [], completedToday: [], viewerMemberId: null, terminalWaits: waits,
  });
  const wait = (id: string, since = '2026-11-14T05:00:00Z') => ({ agentId: id, agentName: `에이전트 ${id}`, deviceName: '맥', since, conversationId: null, conversationProjectId: null });

  it('기다림 0 → 손 필요 0(지금 그대로) · 1 → 1 · 여럿 → 여럿, 배지 = 머리 한 줄 = 행 수', () => {
    expect(deriveHome(base([])).badge).toBe(0);
    expect(deriveHome(base(undefined)).badge).toBe(0);
    const one = deriveHome(base([wait('a')]));
    expect(one.badge).toBe(1);
    expect(one.header.needsHand).toBe(1);
    expect(one.needsHand[0]).toMatchObject({ key: 'terminal:a', kind: 'terminal-wait', section: 'needs-hand', title: '에이전트 a', actor: { type: 'agent', name: '에이전트 a' } });
    const many = deriveHome(base([wait('a'), wait('b'), wait('c')]));
    expect([many.badge, many.header.needsHand, many.needsHand.length]).toEqual([3, 3, 3]);
  });

  it('결재처럼 «막힌 에이전트를 먼저 푸는» 묶음에 들어 알림(멘션)보다 앞에 선다', () => {
    const d = deriveHome({
      ...base([wait('a', '2026-11-14T05:00:00Z')]),
      notifications: [{ id: 'n1', type: 'conversation.mention', title: '멘션', is_read: false, reference_type: null, reference_id: null, created_at: '2026-11-13T01:00:00Z' }],
    });
    expect(d.needsHand.map((r) => r.kind)).toEqual(['terminal-wait', 'mention']);
  });
});
