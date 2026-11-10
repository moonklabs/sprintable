// story #4888 (UI-5 AC4) — deriveHome: one number, what counts, the order, the three sections, the selection after an action. Every test names the rule it guards (see derive-home.ts).
import { describe, expect, it } from 'vitest';
import type { TodayAgentProgressItem, TodayNeedsMeItem } from '../org-briefing/derive-today';
import {
  AGENT_RUN_IN_PROGRESS_STATUSES,
  deriveHome,
  HOME_NEEDS_HAND_NOTIFICATION_TYPES,
  NEEDS_HAND_VISIBLE,
  selectAfterHandled,
  type HomeInput,
  type HomeNotificationInput,
  type HomeStoryInput,
} from './derive-home';

const needsMe = (id: string, createdAt: string, over: Partial<TodayNeedsMeItem> = {}): TodayNeedsMeItem => ({
  id,
  source: 'gate',
  state: 'approval',
  risk: 'low',
  workItemType: 'story',
  workItemId: `wi-${id}`,
  workItemTitle: `결재 ${id}`,
  requestedByName: '개발 에이전트',
  reason: null,
  createdAt,
  conversationId: null,
  conversationProjectId: null,
  recipePublish: false,
  projectId: 'p1',
  ...over,
});

const note = (id: string, type: string, createdAt: string, over: Partial<HomeNotificationInput> = {}): HomeNotificationInput => ({
  id,
  type,
  title: `알림 ${id}`,
  is_read: false,
  reference_type: null,
  reference_id: null,
  created_at: createdAt,
  ...over,
});

const run = (runId: string, status: string, startedAt: string): TodayAgentProgressItem => ({ runId, agentName: '리서치 에이전트', workItemTitle: `실행 ${runId}`, status, startedAt, cancel: null });

const story = (id: string, status: string, assignees: HomeStoryInput['assignees'], updatedAt = '2026-11-10T01:00:00Z'): HomeStoryInput => ({ id, title: `일감 ${id}`, status, assignees, updatedAt });

const ME = 'me-1';
const base = (over: Partial<HomeInput> = {}): HomeInput => ({
  snapshot: { needsMe: [], agentProgress: [] },
  notifications: [],
  stories: [],
  completedToday: [],
  viewerMemberId: ME,
  ...over,
});

describe('rule 1 — one number', () => {
  it('badge = rows in «내 손이 필요해요» = the header number, for every mix of sources', () => {
    const m = deriveHome(
      base({
        snapshot: { needsMe: [needsMe('a', '2026-11-10T01:00:00Z'), needsMe('b', '2026-11-10T02:00:00Z')], agentProgress: [] },
        notifications: [note('n1', 'conversation.mention', '2026-11-10T03:00:00Z'), note('n2', 'story_assigned', '2026-11-10T04:00:00Z')],
      }),
    );
    expect(m.needsHand).toHaveLength(4);
    expect(m.badge).toBe(4);
    expect(m.header.needsHand).toBe(m.badge);
  });

  it('the badge counts ALL rows, not only the 5 shown', () => {
    const many = Array.from({ length: 9 }, (_, i) => needsMe(`g${i}`, `2026-11-10T0${i}:00:00Z`));
    const m = deriveHome(base({ snapshot: { needsMe: many, agentProgress: [] } }));
    expect(m.badge).toBe(9);
    expect(m.needsHandVisible).toHaveLength(NEEDS_HAND_VISIBLE);
    expect(m.needsHandHidden).toBe(4);
  });
});

describe('rule 2 — what counts as «my hand is needed»', () => {
  it('gate.pending_approval is never counted on top of the approval row', () => {
    const m = deriveHome(
      base({
        snapshot: { needsMe: [needsMe('a', '2026-11-10T01:00:00Z', { workItemId: 'wi-a' })], agentProgress: [] },
        notifications: [note('n1', 'gate.pending_approval', '2026-11-10T01:00:00Z', { reference_id: 'wi-a' })],
      }),
    );
    expect(m.badge).toBe(1);
    expect(m.needsHand.map((r) => r.key)).toEqual(['gate:a']);
  });

  it('information is not a task: chat messages · status changes · system dispatches · «limit lifted»', () => {
    const m = deriveHome(
      base({
        notifications: ['conversation.message', 'story_status_changed', 'dispatched', 'agent.limit_lifted', 'something_new'].map((t, i) => note(`n${i}`, t, `2026-11-10T0${i}:00:00Z`)),
      }),
    );
    expect(m.badge).toBe(0);
  });

  it('what needs a person: the exact strings the backend publishes (spelled out here, not read back from the module) — each its own kind', () => {
    const published: Array<[string, string]> = [
      ['conversation.mention', 'mention'],
      ['story_assigned', 'assigned'],
      ['task_assigned', 'assigned'],
      ['agent.permission_request', 'permission'],
      ['agent.restart_stopped', 'stopped'],
      ['agent.limit_paused', 'limit-paused'],
    ];
    const m = deriveHome(base({ notifications: published.map(([type], i) => note(`n${i}`, type, `2026-11-10T0${i}:00:00Z`)) }));
    expect(m.badge).toBe(published.length);
    expect(m.needsHand.map((r) => r.kind)).toEqual(published.map(([, kind]) => kind));
    expect(Object.keys(HOME_NEEDS_HAND_NOTIFICATION_TYPES).sort()).toEqual(published.map(([type]) => type).sort());
  });

  it('a mention about a work item whose approval is already listed is its own row (two different asks)', () => {
    const m = deriveHome(
      base({
        snapshot: { needsMe: [needsMe('a', '2026-11-10T01:00:00Z', { workItemId: 'wi-a' })], agentProgress: [] },
        notifications: [note('n1', 'conversation.mention', '2026-11-10T02:00:00Z', { reference_id: 'wi-a' })],
      }),
    );
    expect(m.badge).toBe(2);
  });

  it('only UNREAD notifications count', () => {
    const m = deriveHome(base({ notifications: [note('n1', 'conversation.mention', '2026-11-10T01:00:00Z', { is_read: true }), note('n2', 'conversation.mention', '2026-11-10T02:00:00Z')] }));
    expect(m.needsHand.map((r) => r.key)).toEqual(['notification:n2']);
  });

  it('the approval kinds of the snapshot keep their state (approval · signature · answer)', () => {
    const m = deriveHome(
      base({
        snapshot: {
          needsMe: [needsMe('a', '2026-11-10T01:00:00Z', { state: 'signature' }), needsMe('b', '2026-11-10T02:00:00Z', { state: 'answer', source: 'hitl' })],
          agentProgress: [],
        },
      }),
    );
    expect(m.needsHand.map((r) => r.kind)).toEqual(['signature', 'answer']);
    expect(m.needsHand[1]!.ref.type).toBe('hitl');
  });
});

describe('rule 3 — longest wait first', () => {
  it('orders by the time the wait began, across sources, ties by key', () => {
    const m = deriveHome(
      base({
        snapshot: { needsMe: [needsMe('late', '2026-11-10T09:00:00Z'), needsMe('early', '2026-11-10T01:00:00Z')], agentProgress: [] },
        notifications: [note('mid', 'conversation.mention', '2026-11-10T05:00:00Z')],
      }),
    );
    expect(m.needsHand.map((r) => r.key)).toEqual(['gate:early', 'notification:mid', 'gate:late']);
    expect(m.initialSelection).toBe('gate:early');
  });
});

describe('rule 3 — ties', () => {
  it('rows with the same time keep a stable order by key (not input order)', () => {
    const same = '2026-11-10T01:00:00Z';
    const a = deriveHome(base({ snapshot: { needsMe: [needsMe('b', same), needsMe('a', same), needsMe('c', same)], agentProgress: [] } }));
    const b = deriveHome(base({ snapshot: { needsMe: [needsMe('c', same), needsMe('b', same), needsMe('a', same)], agentProgress: [] } }));
    expect(a.needsHand.map((r) => r.key)).toEqual(['gate:a', 'gate:b', 'gate:c']);
    expect(b.needsHand.map((r) => r.key)).toEqual(['gate:a', 'gate:b', 'gate:c']);
  });
});

describe('rule 4 — «일하는 중»', () => {
  it('holds the active agent runs and the in-progress stories of mine or of an agent — not other people\'s, not other statuses', () => {
    const m = deriveHome(
      base({
        snapshot: { needsMe: [], agentProgress: [run('r1', 'running', '2026-11-10T01:00:00Z'), run('r2', 'finished', '2026-11-10T02:00:00Z')] },
        stories: [
          story('mine', 'in-progress', [{ id: ME, type: 'human', name: '나' }]),
          story('agent', 'in-progress', [{ id: 'ag-1', type: 'agent', name: '개발 에이전트' }]),
          story('someone-else', 'in-progress', [{ id: 'other-human', type: 'human', name: '남' }]),
          story('review', 'in-review', [{ id: 'ag-1', type: 'agent', name: '개발 에이전트' }]),
          story('mine-backlog', 'backlog', [{ id: ME, type: 'human', name: '나' }]),
        ],
      }),
    );
    expect(m.working.map((r) => r.key).sort()).toEqual(['run:r1', 'story:agent', 'story:mine']);
    expect(m.header.working).toBe(3);
  });

  it('the agent-run statuses are the backend\'s in-progress set: hitl_pending and cancel_requested stay, finished ones go', () => {
    expect([...AGENT_RUN_IN_PROGRESS_STATUSES].sort()).toEqual(['cancel_requested', 'held', 'hitl_pending', 'queued', 'running']);
    const m = deriveHome(
      base({
        snapshot: {
          needsMe: [],
          agentProgress: ['queued', 'held', 'running', 'hitl_pending', 'cancel_requested', 'completed', 'failed', 'abandoned'].map((s, i) => run(`r${i}`, s, `2026-11-10T0${i}:00:00Z`)),
        },
      }),
    );
    expect(m.working.map((r) => r.key)).toEqual(['run:r0', 'run:r1', 'run:r2', 'run:r3', 'run:r4']);
  });

  it('nobody signed in (viewerMemberId null) → only the agents\' stories, never a human assignee\'s', () => {
    const m = deriveHome(
      base({
        viewerMemberId: null,
        stories: [story('h', 'in-progress', [{ id: ME, type: 'human', name: '나' }]), story('a', 'in-progress', [{ id: 'ag-1', type: 'agent', name: '개발 에이전트' }])],
      }),
    );
    expect(m.working.map((r) => r.key)).toEqual(['story:a']);
  });

  it('a story with several assignees: an agent among them makes the actor the agent; me + another human → me', () => {
    const m = deriveHome(
      base({
        stories: [
          story('both', 'in-progress', [{ id: ME, type: 'human', name: '나' }, { id: 'ag-1', type: 'agent', name: '개발 에이전트' }]),
          story('two-humans', 'in-progress', [{ id: 'other', type: 'human', name: '남' }, { id: ME, type: 'human', name: '나' }]),
        ],
      }),
    );
    const by = Object.fromEntries(m.working.map((r) => [r.key, r.actor]));
    expect(by['story:both']).toEqual({ type: 'agent', name: '개발 에이전트' });
    expect(by['story:two-humans']).toEqual({ type: 'human', name: '나' });
  });

  it('the old screen showed 0 of 14 stories: an in-progress story assigned to an agent is on the screen with an agent actor', () => {
    const m = deriveHome(base({ stories: [story('s', 'in-progress', [{ id: 'ag-1', type: 'agent', name: '개발 에이전트' }])] }));
    expect(m.working).toHaveLength(1);
    expect(m.working[0]!.actor).toEqual({ type: 'agent', name: '개발 에이전트' });
  });
});

describe('rule 5 — «방금 끝남»', () => {
  it('most recent first', () => {
    const m = deriveHome(
      base({
        completedToday: [
          { id: 'old', title: '먼저 끝남', actor: null, completedAt: '2026-11-10T01:00:00Z' },
          { id: 'new', title: '방금 끝남', actor: { type: 'agent', name: '글쓰기 에이전트' }, completedAt: '2026-11-10T08:00:00Z' },
        ],
      }),
    );
    expect(m.justDone.map((r) => r.key)).toEqual(['done:new', 'done:old']);
    expect(m.header.justDone).toBe(2);
  });
});

describe('rule 6 — the next row is selected after an action', () => {
  const rows = (keys: string[]) => keys.map((key) => ({ key }) as never);

  it('selects the row that now sits where the handled one was', () => {
    expect(selectAfterHandled(rows(['a', 'b', 'c']), 'b')).toBe('c');
    expect(selectAfterHandled(rows(['a', 'b', 'c']), 'a')).toBe('b');
  });

  it('the last row handled → the one before it; the only row handled → nothing', () => {
    expect(selectAfterHandled(rows(['a', 'b', 'c']), 'c')).toBe('b');
    expect(selectAfterHandled(rows(['a']), 'a')).toBeNull();
  });

  it('a key that is not in the list falls back to the first row', () => {
    expect(selectAfterHandled(rows(['a', 'b']), 'zzz')).toBe('a');
    expect(selectAfterHandled([], 'zzz')).toBeNull();
  });
});

describe('the empty state', () => {
  it('nothing needs a hand → badge 0 and no selection', () => {
    const m = deriveHome(base());
    expect(m.badge).toBe(0);
    expect(m.initialSelection).toBeNull();
    expect(m.needsHandVisible).toEqual([]);
    expect(m.needsHandHidden).toBe(0);
  });
});
