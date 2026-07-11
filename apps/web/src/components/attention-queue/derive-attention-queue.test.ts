import { describe, expect, it } from 'vitest';
import {
  deriveGateAttentionItems, deriveBlockedAttentionItems, buildAttentionQueue,
  type AttentionStoryLite, type AttentionMember, type AttentionQueueItem,
} from './derive-attention-queue';
import type { GateItem } from '@/components/kanban/types';

function gate(overrides: Partial<GateItem> = {}): GateItem {
  return {
    id: 'gate-1', work_item_id: 'story-1', work_item_type: 'story', gate_type: 'merge',
    status: 'pending', resolver_id: null, resolved_at: null, resolution_note: null,
    neutral_facts: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

const stories = new Map<string, AttentionStoryLite>([
  ['story-1', { id: 'story-1', title: '결제 복구 플로우', assignee_id: 'm-1' }],
  ['story-2', { id: 'story-2', title: '온보딩 위저드', assignee_id: null }],
]);

const members = new Map<string, AttentionMember>([
  ['m-1', { name: '미르코', type: 'agent' }],
]);

describe('deriveGateAttentionItems', () => {
  it('maps merge gate + ci_result=fail to verify_fail (amber, neutral tone)', () => {
    const items = deriveGateAttentionItems(
      [gate({ neutral_facts: { ci_result: 'fail' } })], stories, members,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('verify_fail');
    expect(items[0]!.proofState).toBe('amber');
    expect(items[0]!.actionTone).toBe('neutral');
    expect(items[0]!.claim).toContain('결제 복구 플로우');
  });

  it('maps merge gate + ci_result=pass to merge_ready (green, ready tone)', () => {
    const items = deriveGateAttentionItems(
      [gate({ neutral_facts: { ci_result: 'pass' } })], stories, members,
    );
    expect(items[0]!.kind).toBe('merge_ready');
    expect(items[0]!.proofState).toBe('green');
    expect(items[0]!.actionTone).toBe('ready');
  });

  it('maps loop_decision gate to decision_needed (amber, primary tone) regardless of ci_result', () => {
    const items = deriveGateAttentionItems(
      [gate({ gate_type: 'loop_decision', neutral_facts: null })], stories, members,
    );
    expect(items[0]!.kind).toBe('decision_needed');
    expect(items[0]!.actionTone).toBe('primary');
  });

  it('resolves the assignee as actor when present, omits when absent (no-fiction)', () => {
    const withActor = deriveGateAttentionItems([gate({ neutral_facts: { ci_result: 'fail' } })], stories, members);
    expect(withActor[0]!.actor).toEqual({ name: '미르코', isAgent: true });

    const withoutActor = deriveGateAttentionItems(
      [gate({ work_item_id: 'story-2', neutral_facts: { ci_result: 'fail' } })], stories, members,
    );
    expect(withoutActor[0]!.actor).toBeNull();
  });

  it('skips gates whose story is unknown (never fabricates a claim)', () => {
    const items = deriveGateAttentionItems(
      [gate({ work_item_id: 'story-unknown', neutral_facts: { ci_result: 'fail' } })], stories, members,
    );
    expect(items).toHaveLength(0);
  });

  it('skips non-story gates (e.g. doc_approval) and non-pending gates', () => {
    const items = deriveGateAttentionItems(
      [
        gate({ work_item_type: 'doc', gate_type: 'doc_approval' }),
        gate({ status: 'rejected', neutral_facts: { ci_result: 'fail' } }),
        gate({ gate_type: 'merge', neutral_facts: { ci_result: null } }), // no honest signal → skip
      ],
      stories, members,
    );
    expect(items).toHaveLength(0);
  });
});

describe('deriveBlockedAttentionItems', () => {
  it('maps a non-empty blockedByMap entry to a blocked item with the real blocker count', () => {
    const items = deriveBlockedAttentionItems({ 'story-1': ['story-9', 'story-10'] }, stories, members);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('blocked');
    expect(items[0]!.claim).toContain('2건');
    expect(items[0]!.claim).toContain('결제 복구 플로우');
  });

  it('skips empty blocker arrays and unknown story ids', () => {
    const items = deriveBlockedAttentionItems(
      { 'story-1': [], 'story-unknown': ['story-9'] }, stories, members,
    );
    expect(items).toHaveLength(0);
  });
});

describe('buildAttentionQueue', () => {
  function item(kind: AttentionQueueItem['kind'], sortKey: number): AttentionQueueItem {
    return {
      id: `${kind}-${sortKey}`, kind, kindLabel: kind, proofState: kind === 'merge_ready' ? 'green' : 'amber',
      claim: kind, actor: null, actionLabel: '가기', actionTone: 'neutral', href: '/board', sortKey,
    };
  }

  it('sorts amber-tier items before merge_ready (green), most-recent-first within a tier', () => {
    const { shown } = buildAttentionQueue([
      item('merge_ready', 100),
      item('verify_fail', 10),
      item('blocked', 20),
    ]);
    expect(shown.map((i) => i.kind)).toEqual(['blocked', 'verify_fail', 'merge_ready']);
  });

  it('caps at 7 and reports the honest overflow count (not a fabricated activity metric)', () => {
    const items = Array.from({ length: 10 }, (_, i) => item('decision_needed', i));
    const { shown, overflow } = buildAttentionQueue(items);
    expect(shown).toHaveLength(7);
    expect(overflow).toBe(3);
  });

  it('does not pad below 3 — an honestly-small queue stays small', () => {
    const { shown, overflow } = buildAttentionQueue([item('verify_fail', 1)]);
    expect(shown).toHaveLength(1);
    expect(overflow).toBe(0);
  });
});
