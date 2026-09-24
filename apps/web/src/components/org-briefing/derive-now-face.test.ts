import { describe, expect, it } from 'vitest';
import {
  parseCompletionNotifications, parseMyActions,
  type RawMyActions,
} from './derive-now-face';

function emptyRaw(): RawMyActions {
  return {
    queue: [], attention: [],
    loopOverdueHypothesisCount: 0, loopOverdueGoalCount: 0, loopOutcomeMissingGoalCount: 0,
    measurePlanMissingGoalCount: 0, unmeasurableGoalCount: 0,
  };
}

describe('parseMyActions', () => {
  it('unwraps the {data:{...}} proxy envelope', () => {
    const raw = parseMyActions({
      data: { action_queue: { items: [{ type: 'gate_approval', priority: 'warn', context: {} }] }, attention: { items: [] } },
    });
    expect(raw.queue).toHaveLength(1);
  });

  it('reads the raw (unwrapped) BE shape too', () => {
    const raw = parseMyActions({
      action_queue: { items: [{ type: 'review_merge', title: 'Foo', context: { story_id: 's1' } }] },
      attention: { items: [] },
    });
    expect(raw.queue).toHaveLength(1);
    expect(raw.queue[0]!.title).toBe('Foo');
  });

  it('captures my_blockers even though the legacy FE QueueItem type omits it (BE grounding gap)', () => {
    const raw = parseMyActions({
      action_queue: { items: [{ type: 'my_blockers', context: { blocked_story_id: 's2' } }] },
      attention: { items: [] },
    });
    expect(raw.queue).toHaveLength(1);
    expect(raw.queue[0]!.type).toBe('my_blockers');
  });

  it('captures story_stalled and unanswered_blocker even though the legacy FE AttentionItem type only declares agent_stuck', () => {
    const raw = parseMyActions({
      action_queue: { items: [] },
      attention: { items: [
        { type: 'story_stalled', story_id: 's3' },
        { type: 'unanswered_blocker', blocked_story_id: 's4' },
      ] },
    });
    expect(raw.attention).toHaveLength(2);
    expect(raw.attention.map((a) => a.type)).toEqual(['story_stalled', 'unanswered_blocker']);
  });

  // PO 실측 결함(2026-08-09) — story_stalled/unanswered_blocker는 entity_type/entity_id를
  // 아예 안 낸다(command_center.py:379-406). story_id/blocked_story_id/title을 읽어야 한다.
  it('reads story_id/title for story_stalled and blocked_story_id for unanswered_blocker (not entity_id — BE never sends it for these two types)', () => {
    const raw = parseMyActions({
      action_queue: { items: [] },
      attention: { items: [
        { type: 'story_stalled', story_id: 's3', stalled_days: 5, title: '결제 완료율 개선' },
        { type: 'unanswered_blocker', blocked_story_id: 's4', blocker_id: 's5', age_days: 3 },
      ] },
    });
    expect(raw.attention[0]).toMatchObject({ type: 'story_stalled', story_id: 's3', title: '결제 완료율 개선' });
    expect(raw.attention[1]).toMatchObject({ type: 'unanswered_blocker', blocked_story_id: 's4' });
  });

  // story #2539(BE)/#2541(FE) — 4번째 attention type. severity=info이지만 이 파서는 severity를
  // 안 읽는다(전부 kind=signal로 매핑, priority만 내부적으로 다르게 — §2539 스코프: "방금
  // 반증으로 종결" 결과 통보뿐, in-flight 이상감지 아님).
  it('reads hypothesis_id/statement/outcome_result/falsified_days/superseded_by_hypothesis_id for hypothesis_falsified', () => {
    const raw = parseMyActions({
      action_queue: { items: [] },
      attention: { items: [
        {
          type: 'hypothesis_falsified', hypothesis_id: 'h1', statement: '결제 완료율 개선',
          outcome_result: { metric: 'checkout_rate', target: 60, actual: 52, direction: 'up' },
          falsified_days: 2, superseded_by_hypothesis_id: 'h2',
        },
      ] },
    });
    expect(raw.attention[0]).toMatchObject({
      type: 'hypothesis_falsified', hypothesis_id: 'h1', statement: '결제 완료율 개선',
      falsified_days: 2, superseded_by_hypothesis_id: 'h2',
    });
    expect(raw.attention[0]!.outcome_result).toEqual({ metric: 'checkout_rate', target: 60, actual: 52, direction: 'up' });
  });

  it('returns empty arrays for malformed shapes (no-fiction, throw 0)', () => {
    expect(parseMyActions(null)).toEqual(emptyRaw());
    expect(parseMyActions(undefined)).toEqual(emptyRaw());
    expect(parseMyActions({ foo: 'bar' })).toEqual(emptyRaw());
    expect(parseMyActions('nope')).toEqual(emptyRaw());
  });

  it('skips queue/attention entries with no type (cannot render a kind pill without it)', () => {
    const raw = parseMyActions({
      action_queue: { items: [{ context: {} }] },
      attention: { items: [{ entity_id: 'x' }] },
    });
    expect(raw.queue).toHaveLength(0);
    expect(raw.attention).toHaveLength(0);
  });
});

describe('parseCompletionNotifications', () => {
  it('unwraps {data:[...]} and drops rows without id/title (no-fiction)', () => {
    const rows = parseCompletionNotifications({
      data: [
        { id: 'n1', title: 'BE 계약 완료', body: '근거 3건', href: '/inbox' },
        { id: 'n2' }, // no title — dropped
        { title: 'no id' }, // no id — dropped
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('n1');
  });

  it('returns [] for non-array payloads', () => {
    expect(parseCompletionNotifications(null)).toEqual([]);
    expect(parseCompletionNotifications({ data: 'nope' })).toEqual([]);
  });
});

