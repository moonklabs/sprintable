import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  buildNowFace, parseCompletionNotifications, parseMyActions,
  type NowFaceTranslator, type RawMyActions,
} from './derive-now-face';
import koMessagesRaw from '../../../messages/ko.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;
const t = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'orgBriefing' }) as unknown as NowFaceTranslator;

function emptyRaw(): RawMyActions {
  return { queue: [], attention: [] };
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

describe('buildNowFace', () => {
  it('maps gate_approval/review_merge/my_blockers to kind=decide, agent_stuck/story_stalled/unanswered_blocker to kind=signal, notifications to kind=done', () => {
    const raw: RawMyActions = {
      queue: [
        { type: 'gate_approval', priority: 'warn', title: null, context: {} },
        { type: 'review_merge', priority: 'info', title: 'My Story', context: { story_id: 's1' } },
        { type: 'my_blockers', priority: null, title: null, context: { blocked_story_id: 's2' } },
      ],
      attention: [
        { type: 'agent_stuck', entity_type: 'story', entity_id: 's3', gate_type: 'merge', story_id: null, blocked_story_id: null, title: null },
        { type: 'story_stalled', entity_type: null, entity_id: null, gate_type: null, story_id: 's4', blocked_story_id: null, title: null },
        { type: 'unanswered_blocker', entity_type: null, entity_id: null, gate_type: null, story_id: null, blocked_story_id: 's5', title: null },
      ],
    };
    const notifications = [{ id: 'n1', title: 'Contract done', body: 'evidence attached', href: '/inbox' }];
    const items = buildNowFace(raw, notifications, t);

    expect(items.filter((i) => i.kind === 'decide')).toHaveLength(3);
    expect(items.filter((i) => i.kind === 'signal')).toHaveLength(3);
    expect(items.filter((i) => i.kind === 'done')).toHaveLength(1);
  });

  it('PO 실측 결함 fix — story_stalled href/id는 story_id 기반이고, title은 BE값 있으면 그걸 쓴다', () => {
    const raw: RawMyActions = {
      queue: [],
      attention: [
        { type: 'story_stalled', entity_type: null, entity_id: null, gate_type: null, story_id: 's9', blocked_story_id: null, title: '결제 완료율 개선' },
      ],
    };
    const items = buildNowFace(raw, [], t);
    const signal = items.find((i) => i.kind === 'signal');
    expect(signal?.href).toBe('/board?story=s9');
    expect(signal?.id).toBe('story_stalled-s9');
    expect(signal?.title).toBe('결제 완료율 개선');
  });

  it('story_stalled title이 아직 없으면(디디 BE 배선 前) 스토리-주제 폴백 문구를 쓴다(가설 문구 아님)', () => {
    const raw: RawMyActions = {
      queue: [],
      attention: [
        { type: 'story_stalled', entity_type: null, entity_id: null, gate_type: null, story_id: 's9', blocked_story_id: null, title: null },
      ],
    };
    const items = buildNowFace(raw, [], t);
    const signal = items.find((i) => i.kind === 'signal');
    expect(signal?.title).not.toContain('가설');
    expect(signal?.title).toBe('스토리가 오래 멈춰 있습니다');
  });

  it('unanswered_blocker href/id는 blocked_story_id 기반이다(entity_id는 BE가 안 준다)', () => {
    const raw: RawMyActions = {
      queue: [],
      attention: [
        { type: 'unanswered_blocker', entity_type: null, entity_id: null, gate_type: null, story_id: null, blocked_story_id: 's7', title: null },
      ],
    };
    const items = buildNowFace(raw, [], t);
    const signal = items.find((i) => i.kind === 'signal');
    expect(signal?.href).toBe('/board?story=s7');
    expect(signal?.id).toBe('unanswered_blocker-s7');
  });

  it('never leaks raw elapsed-time text into signal context copy (surveillance framing ban — doc §1.5/§1.7)', () => {
    const raw: RawMyActions = {
      queue: [],
      attention: [{ type: 'agent_stuck', entity_type: 'story', entity_id: 's1', gate_type: 'merge', story_id: null, blocked_story_id: null, title: null }],
    };
    const items = buildNowFace(raw, [], t);
    const signal = items.find((i) => i.kind === 'signal');
    expect(signal).toBeDefined();
    // no digit-based duration phrasing ("N분", "N일", "N시간") anywhere in the rendered copy.
    expect(`${signal!.title} ${signal!.context}`).not.toMatch(/\d+\s*(분|시간|일)/);
  });

  it('marks only the single highest-priority decide item as primary; every other row (including other decide rows) is ghost', () => {
    const raw: RawMyActions = {
      queue: [
        { type: 'my_blockers', priority: null, title: null, context: {} }, // priority -1 (highest)
        { type: 'gate_approval', priority: 'danger', title: null, context: {} },
      ],
      attention: [],
    };
    const items = buildNowFace(raw, [], t);
    const primaries = items.filter((i) => i.actionTone === 'primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.id).toMatch(/^my_blockers-/);
  });

  it('produces no primary action when there are no decide items', () => {
    const raw: RawMyActions = { queue: [], attention: [{ type: 'agent_stuck', entity_type: null, entity_id: 's1', gate_type: null, story_id: null, blocked_story_id: null, title: null }] };
    const items = buildNowFace(raw, [], t);
    expect(items.every((i) => i.actionTone === 'ghost')).toBe(true);
  });

  it('sorts decide before signal before done', () => {
    const raw: RawMyActions = {
      queue: [{ type: 'review_merge', priority: 'info', title: 'x', context: {} }],
      attention: [{ type: 'agent_stuck', entity_type: null, entity_id: 's1', gate_type: null, story_id: null, blocked_story_id: null, title: null }],
    };
    const items = buildNowFace(raw, [{ id: 'n1', title: 'done', body: null, href: null }], t);
    expect(items.map((i) => i.kind)).toEqual(['decide', 'signal', 'done']);
  });

  it('returns [] when there is nothing pending (feeds the calm empty state)', () => {
    expect(buildNowFace(emptyRaw(), [], t)).toEqual([]);
  });
});
