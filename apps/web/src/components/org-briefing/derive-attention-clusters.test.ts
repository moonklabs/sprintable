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
    type: 'hypothesis_falsified',
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
    project_id: null,
    project_slug: null,
    member_id: null,
    reason: null,
    failure_count: null,
    first_failed_at: null,
    last_failed_at: null,
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
  });

  // story #93b076c8(2250) — story_stalled 클러스터링(dedup·정렬·폴백)은 이 함수에서 제거되고
  // silentStall(별도 BE 엔드포인트 소스)로 대체됐다 — 그 동작의 테스트는
  // derive-silent-stall-clusters.test.ts로 이관.

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

  it('무관 타입이 섞여 들어와도 falsified 클러스터만 걸러 담긴다', () => {
    const clusters = deriveAttentionClusters([
      attentionItem({ type: 'hypothesis_falsified', hypothesis_id: 'h1', statement: 'X', falsified_days: 1 }),
      attentionItem({ type: 'agent_stuck', entity_id: 's2' }),
    ], t);
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
        measurePlanMissingGoalCount: 40, unmeasurableGoalCount: 7,
      });
      expect(clusters.loop).toHaveLength(20); // items[]는 cap된 그대로
      expect(clusters.loopTotalCount).toBe(6 + 2 + 51); // count 필드 합 — items.length(20)와 다름
      expect(clusters.measurePlanMissingGoalCount).toBe(40);
      expect(clusters.unmeasurableGoalCount).toBe(7);
    });

    it('loopCounts 미제공 시(구 호출부) loopTotalCount는 items.length로 폴백한다(회귀 0)', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'loop_overdue_hypothesis', hypothesis_id: 'h1', overdue_days: 1 }),
      ], t);
      expect(clusters.loopTotalCount).toBe(1);
      expect(clusters.measurePlanMissingGoalCount).toBe(0);
      expect(clusters.unmeasurableGoalCount).toBe(0);
    });
  });

  // story #2842(0b17472c 그라운딩) — href를 항목의 실제 소속 프로젝트로 짓고, 뷰어의 활성
  // 프로젝트와 다를 때만 crossProjectLabel을 채운다.
  describe('project-scoped href · cross-project 병기(story #2842)', () => {
    it('viewer(orgSlug+activeProjectId) 제공 시 href가 항목 소속 프로젝트 slug로 지어진다', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'loop_overdue_goal', goal_id: 'g1', overdue_days: 1, project_id: 'p-other', project_slug: 'other-proj' }),
      ], t, undefined, { orgSlug: 'moonklabs', activeProjectId: 'p-active' });
      expect(clusters.loop[0]!.href).toBe('/moonklabs/other-proj/flow?view=flow&goal=g1');
    });

    it('같은 프로젝트 소속이면 crossProjectLabel이 null(노이즈 절제) — href는 여전히 완전 경로', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'loop_overdue_goal', goal_id: 'g1', overdue_days: 1, project_id: 'p-active', project_slug: 'sprintable' }),
      ], t, undefined, { orgSlug: 'moonklabs', activeProjectId: 'p-active' });
      expect(clusters.loop[0]!.crossProjectLabel).toBeNull();
      expect(clusters.loop[0]!.href).toBe('/moonklabs/sprintable/flow?view=flow&goal=g1');
    });

    it('다른 프로젝트 소속이면 crossProjectLabel에 project_slug가 채워진다', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'loop_overdue_goal', goal_id: 'g1', overdue_days: 1, project_id: 'p-other', project_slug: 'other-proj' }),
      ], t, undefined, { orgSlug: 'moonklabs', activeProjectId: 'p-active' });
      expect(clusters.loop[0]!.crossProjectLabel).toBe('other-proj');
    });

    it('viewer 미제공(구 호출부)이면 crossProjectLabel은 항상 null·href는 기존 bare path로 폴백(오탐 방지·회귀 0)', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'loop_overdue_goal', goal_id: 'g1', overdue_days: 1, project_id: 'p-other', project_slug: 'other-proj' }),
      ], t);
      expect(clusters.loop[0]!.crossProjectLabel).toBeNull();
      expect(clusters.loop[0]!.href).toBe('/flow?view=flow&goal=g1');
    });

    it('project_slug가 없으면(BE 미해소) orgSlug가 있어도 bare path로 폴백한다', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'loop_overdue_goal', goal_id: 'g1', overdue_days: 1, project_id: 'p-other', project_slug: null }),
      ], t, undefined, { orgSlug: 'moonklabs', activeProjectId: 'p-active' });
      expect(clusters.loop[0]!.href).toBe('/flow?view=flow&goal=g1');
      expect(clusters.loop[0]!.crossProjectLabel).toBeNull();
    });
  });

  // story #2852(2836 FE 조각, BE PR#3266) — agent_auth_failure는 BE가 이미 (member_id, reason)
  // 그룹핑해서 낸다 — 원시 항목 1건 = 클러스터 행 1건 그대로.
  describe('agent_auth_failure(story #2852)', () => {
    it('member_id/reason/failure_count/first·last_failed_at을 그대로 옮긴다', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({
          type: 'agent_auth_failure', member_id: 'm1', reason: 'expired', failure_count: 7,
          first_failed_at: '2026-08-20T10:00:00Z', last_failed_at: '2026-08-20T10:04:00Z',
        }),
      ], t);
      expect(clusters.authFailure).toHaveLength(1);
      expect(clusters.authFailure[0]).toMatchObject({
        memberId: 'm1', reason: 'expired', failureCount: 7,
        firstFailedAt: '2026-08-20T10:00:00Z', lastFailedAt: '2026-08-20T10:04:00Z',
      });
    });

    it('reason이 없으면(BE 계약 위반·no-fiction) 항목을 만들지 않는다', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'agent_auth_failure', member_id: 'm1', reason: null, failure_count: 3 }),
      ], t);
      expect(clusters.authFailure).toHaveLength(0);
    });

    it('member_id가 null이어도(귀속 불가) reason이 있으면 항목은 만든다 — 렌더에서 이름 폴백', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'agent_auth_failure', member_id: null, reason: 'invalid', failure_count: 5 }),
      ], t);
      expect(clusters.authFailure).toHaveLength(1);
      expect(clusters.authFailure[0]!.memberId).toBeNull();
    });

    it('최근 실패순(last_failed_at 내림차순)으로 정렬된다', () => {
      const clusters = deriveAttentionClusters([
        attentionItem({ type: 'agent_auth_failure', member_id: 'old', reason: 'expired', failure_count: 5, last_failed_at: '2026-08-19T00:00:00Z' }),
        attentionItem({ type: 'agent_auth_failure', member_id: 'recent', reason: 'revoked', failure_count: 5, last_failed_at: '2026-08-20T00:00:00Z' }),
      ], t);
      expect(clusters.authFailure.map((a) => a.memberId)).toEqual(['recent', 'old']);
    });
  });
});
