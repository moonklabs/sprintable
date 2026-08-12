import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { deriveAttentionClusters, type ClusterTranslator } from './derive-attention-clusters';
import type { RawAttentionItem } from './derive-now-face';
import koMessagesRaw from '../../../messages/ko.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;
const t = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'orgBriefing' }) as unknown as ClusterTranslator;

function attentionItem(overrides: Partial<RawAttentionItem>): RawAttentionItem {
  return {
    type: 'story_stalled',
    entity_type: null,
    entity_id: null,
    gate_type: null,
    story_id: null,
    stalled_days: null,
    blocked_story_id: null,
    title: null,
    hypothesis_id: null,
    statement: null,
    outcome_result: null,
    falsified_days: null,
    superseded_by_hypothesis_id: null,
    ...overrides,
  };
}

describe('deriveAttentionClusters', () => {
  it('ignores agent_stuck/unanswered_blocker — those two stay in buildNowFace, not this cluster board', () => {
    const clusters = deriveAttentionClusters([
      attentionItem({ type: 'agent_stuck', entity_id: 's1' }),
      attentionItem({ type: 'unanswered_blocker', blocked_story_id: 's2' }),
    ], t);
    expect(clusters.falsified).toHaveLength(0);
    expect(clusters.stalled).toHaveLength(0);
  });

  it('story #2541 AC1 — story_stalled 20건이 flood 아니라 정체 클러스터 하나로 묶인다(dedup=집계, 개별 데이터는 안 지움)', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      attentionItem({ type: 'story_stalled', story_id: `s${i}`, stalled_days: i + 1, title: `스토리 ${i}` }));
    const clusters = deriveAttentionClusters(items, t);
    expect(clusters.stalled).toHaveLength(20);
  });

  it('정체는 일수순(내림차순 — 오래 묵은 것 먼저)으로 정렬된다', () => {
    const clusters = deriveAttentionClusters([
      attentionItem({ type: 'story_stalled', story_id: 's1', stalled_days: 3, title: 'A' }),
      attentionItem({ type: 'story_stalled', story_id: 's2', stalled_days: 9, title: 'B' }),
      attentionItem({ type: 'story_stalled', story_id: 's3', stalled_days: 6, title: 'C' }),
    ], t);
    expect(clusters.stalled.map((s) => s.title)).toEqual(['B', 'C', 'A']);
    expect(clusters.stalled.map((s) => s.days)).toEqual([9, 6, 3]);
  });

  it('story_id/title이 없으면 폴백 href·문구를 쓴다(no-fiction 안 지어냄)', () => {
    const clusters = deriveAttentionClusters([attentionItem({ type: 'story_stalled' })], t);
    expect(clusters.stalled[0]!.href).toBe('/board');
    expect(clusters.stalled[0]!.title).toBe('스토리가 오래 멈춰 있습니다');
    expect(clusters.stalled[0]!.days).toBeNull();
  });

  it('가설 반증은 최근순(falsified_days 오름차순)으로 정렬되고 target/actual·대체가설 링크를 담는다', () => {
    const clusters = deriveAttentionClusters([
      attentionItem({
        type: 'hypothesis_falsified', hypothesis_id: 'h1', statement: '오래된 반증',
        outcome_result: { target: 70, actual: 41 }, falsified_days: 5,
      }),
      attentionItem({
        type: 'hypothesis_falsified', hypothesis_id: 'h2', statement: '최근 반증',
        outcome_result: { target: 8, actual: 7.6 }, falsified_days: 1, superseded_by_hypothesis_id: 'h3',
      }),
    ], t);
    expect(clusters.falsified.map((f) => f.title)).toEqual(['최근 반증', '오래된 반증']);
    expect(clusters.falsified[0]).toMatchObject({ id: 'h2', target: 8, actual: 7.6, hasOutcome: true, supersededId: 'h3', href: '/flow?hypothesis=h2' });
    expect(clusters.falsified[1]!.supersededId).toBeNull();
  });

  it('outcome_result가 없으면 hasOutcome=false — target/actual을 지어내지 않는다', () => {
    const clusters = deriveAttentionClusters([
      attentionItem({ type: 'hypothesis_falsified', hypothesis_id: 'h1', statement: 'X', outcome_result: null }),
    ], t);
    expect(clusters.falsified[0]).toMatchObject({ hasOutcome: false, target: null, actual: null });
  });

  it('두 유형이 섞여 들어와도 각자 클러스터로 갈린다', () => {
    const clusters = deriveAttentionClusters([
      attentionItem({ type: 'story_stalled', story_id: 's1', stalled_days: 2 }),
      attentionItem({ type: 'hypothesis_falsified', hypothesis_id: 'h1', statement: 'X', falsified_days: 1 }),
      attentionItem({ type: 'agent_stuck', entity_id: 's2' }),
    ], t);
    expect(clusters.stalled).toHaveLength(1);
    expect(clusters.falsified).toHaveLength(1);
  });
});
