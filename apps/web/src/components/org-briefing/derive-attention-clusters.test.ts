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
    goal_id: null,
    overdue_days: null,
    done_days: null,
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

  // story #2829/#2830(loop-closure P0) — 「닫힌 적 없는 루프」 3타입.
  describe('loop_overdue_hypothesis · loop_overdue_goal · loop_outcome_missing_goal', () => {
    it('3타입 모두 loop 클러스터로 갈리고 kind/href가 타입별로 정확히 파생된다', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'loop_overdue_hypothesis', hypothesis_id: 'h1', statement: 'A', overdue_days: 3 }),
        attentionItem({ type: 'loop_overdue_goal', goal_id: 'g1', title: 'B', overdue_days: 5 }),
        attentionItem({ type: 'loop_outcome_missing_goal', goal_id: 'g2', title: 'C', done_days: 30 }),
      ], t);
      expect(clusters.loop).toHaveLength(3);
      expect(clusters.loop.find((l) => l.id === 'h1')).toMatchObject({ kind: 'overdueHypothesis', title: 'A', days: 3, href: '/flow?hypothesis=h1' });
      // 유나 design:changes(2026-08-20, PR#3257) — goal 딥링크는 view=flow를 명시해야 데스크톱
      // parseView 기본값('hypothesis')에 밀려 focusGoalId가 드롭되는 걸 막는다(flow-client.tsx).
      expect(clusters.loop.find((l) => l.id === 'g1')).toMatchObject({ kind: 'overdueGoal', title: 'B', days: 5, href: '/flow?view=flow&goal=g1' });
      expect(clusters.loop.find((l) => l.id === 'g2')).toMatchObject({ kind: 'outcomeMissing', title: 'C', days: 30, href: '/flow?view=flow&goal=g2' });
    });

    it('오래 방치된 것부터(days 내림차순)로 정렬된다', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'loop_overdue_goal', goal_id: 'g1', overdue_days: 3 }),
        attentionItem({ type: 'loop_overdue_goal', goal_id: 'g2', overdue_days: 9 }),
      ], t);
      expect(clusters.loop.map((l) => l.id)).toEqual(['g2', 'g1']);
    });

    it('count 3필드의 합이 loopTotalCount다 — items.length가 top-20 cap에 잘려도 참값을 유지', () => {
      const items = Array.from({ length: 20 }, (_, i) => attentionItem({ type: 'loop_outcome_missing_goal', goal_id: `g${i}`, done_days: i }));
      const clusters = deriveAttentionClusters(items, t, {
        loopOverdueHypothesisCount: 6, loopOverdueGoalCount: 2, loopOutcomeMissingGoalCount: 51,
        measurePlanMissingGoalCount: 40,
      });
      expect(clusters.loop).toHaveLength(20); // items[]는 cap된 그대로
      expect(clusters.loopTotalCount).toBe(6 + 2 + 51); // count 필드 합 — items.length(20)와 다름
      expect(clusters.measurePlanMissingGoalCount).toBe(40);
    });

    it('loopCounts 미제공 시(구 호출부) loopTotalCount는 items.length로 폴백한다(회귀 0)', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'loop_overdue_hypothesis', hypothesis_id: 'h1', overdue_days: 1 }),
      ], t);
      expect(clusters.loopTotalCount).toBe(1);
      expect(clusters.measurePlanMissingGoalCount).toBe(0);
    });
  });
});
