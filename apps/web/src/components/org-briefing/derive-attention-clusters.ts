/**
 * story #2541(#2539 스코프 ④ FE 이관, 유나 v4 SSOT f01fa94a) — 홈 브리핑 "신호 유형별 클러스터
 * 보드". 기존 NowFace가 story_stalled를 개별 flat 행으로 20건까지 그대로 나열해 「동일 문구
 * 반복 · 가치 0」 지적(선생님)을 받았다 — 그 원인 자체(derive-now-face.ts buildNowFace)를
 * 건드리지 않고, 같은 `raw.attention`(parseMyActions 산출)을 이 파일이 별도로 읽어 두 유형
 * (가설 반증 · 스토리 정체)만 클러스터로 묶는다. buildNowFace는 이 두 타입을 더는 flat 행으로
 * 안 올린다(중복 표시 방지).
 */
import type { RawAttentionItem } from './derive-now-face';

export interface FalsifiedClusterItem {
  id: string;
  title: string;
  target: number | null;
  actual: number | null;
  hasOutcome: boolean;
  supersededId: string | null;
  href: string;
  // story #2842 — 항목 소속 프로젝트가 뷰어의 활성 프로젝트와 다를 때만 채워짐(같으면
  // null·노이즈 절제). 값은 그 프로젝트의 slug.
  crossProjectLabel: string | null;
}

export interface StalledClusterItem {
  id: string;
  title: string;
  days: number | null;
  href: string;
  crossProjectLabel: string | null;
}

// story #2829/#2830(loop-closure P0) — 「닫힌 적 없는 루프」 3분류 중 N에 포함되는 2류
// (도과 가설·도과 goal·outcome 없이 done된 goal). kind로 배지 문구/href 파생을 가른다.
export type LoopKind = 'overdueHypothesis' | 'overdueGoal' | 'outcomeMissing';

export interface LoopClusterItem {
  id: string;
  kind: LoopKind;
  title: string;
  days: number | null;
  href: string;
  crossProjectLabel: string | null;
}

// story #2852(2836 FE 조각, BE PR#3266) — 에이전트 인증 실패(agent_auth_failure) 관측 신호.
// BE가 이미 (member_id, reason) windowed COUNT로 그룹핑해 낸다 — 원시 항목 1건 = 클러스터
// 행 1건(추가 dedup 불요). member 이름은 여기서 안 붙인다(순수 함수 유지) — 렌더 시
// memberNames 맵으로 붙인다(workforce-face.tsx parseTeamMembers와 동형 관례).
export type AuthFailureReason = 'expired' | 'revoked' | 'invalid';

export interface AuthFailureClusterItem {
  id: string;
  memberId: string | null;
  reason: AuthFailureReason;
  failureCount: number;
  firstFailedAt: string | null;
  lastFailedAt: string | null;
}

// story #2842(0b17472c 그라운딩) — 뷰어 컨텍스트. 미제공(구 호출부·테스트)이면 href는 기존
// bare path로 폴백하고 crossProjectLabel은 항상 null(회귀 0).
export interface ViewerContext {
  orgSlug?: string;
  activeProjectId?: string;
}

function projectHref(viewer: ViewerContext | undefined, projectSlug: string | null, path: string): string {
  if (viewer?.orgSlug && projectSlug) return `/${viewer.orgSlug}/${projectSlug}${path}`;
  return path;
}

function crossProjectLabel(viewer: ViewerContext | undefined, itemProjectId: string | null, projectSlug: string | null): string | null {
  if (!viewer?.activeProjectId || !itemProjectId || !projectSlug) return null;
  return itemProjectId !== viewer.activeProjectId ? projectSlug : null;
}

export interface AttentionClusters {
  falsified: FalsifiedClusterItem[];
  stalled: StalledClusterItem[];
  loop: LoopClusterItem[];
  // items[]가 류별 top-20 cap이라(BE PR#3253) count 배지는 이 필드를 반드시 써야 한다 —
  // loop.length(=items 실수신량)와 다를 수 있다(no-fiction: 서로 다른 두 숫자를 구분 유지).
  loopTotalCount: number;
  // N 비포함·집계만(페드루 PO 보완 지시, doc a8e73bdb §2) — measure_after 자체가 없는
  // active goal. 카드 하단 보조 텍스트 전용.
  measurePlanMissingGoalCount: number;
  // story #2843/#2844 — 명시 "측정 불가" 선언 goal 수. N 비포함·집계만(동형 성격), 카드 하단
  // 보조 텍스트 전용.
  unmeasurableGoalCount: number;
  // story #2852 — 에이전트 인증 실패 그룹(member_id, reason)별 1건.
  authFailure: AuthFailureClusterItem[];
}

export interface LoopCounts {
  loopOverdueHypothesisCount: number;
  loopOverdueGoalCount: number;
  loopOutcomeMissingGoalCount: number;
  measurePlanMissingGoalCount: number;
  unmeasurableGoalCount: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface ClusterTranslator {
  (key: string, values?: Record<string, string | number>): string;
}

/**
 * raw.attention → 두 클러스터. 정렬(AC3): 반증=최근순(falsified_days 오름차순 — 작을수록
 * 최근), 정체=일수순(stalled_days 내림차순 — 오래 묵은 것 먼저, 유나 v4 mockup 예시와 동일).
 * story_id/hypothesis_id가 없는 항목도 no-fiction 원칙상 세지 않을 이유는 없다(BE count와
 * 화면 count가 어긋나면 그게 더 정직하지 않다) — href만 제네릭 폴백으로 둔다(기존
 * buildNowFace의 story_stalled/unanswered_blocker 관례 재사용).
 */
export function deriveAttentionClusters(
  attention: RawAttentionItem[],
  t: ClusterTranslator,
  loopCounts?: LoopCounts,
  viewer?: ViewerContext,
): AttentionClusters {
  const falsified: { item: FalsifiedClusterItem; days: number | null }[] = [];
  const stalled: StalledClusterItem[] = [];
  const loop: { item: LoopClusterItem; days: number | null }[] = [];
  const authFailure: { item: AuthFailureClusterItem; lastFailedAt: string | null }[] = [];

  attention.forEach((a, idx) => {
    if (a.type === 'loop_overdue_hypothesis') {
      loop.push({
        item: {
          id: a.hypothesis_id ?? `loop_overdue_hypothesis-${idx}`,
          kind: 'overdueHypothesis',
          title: a.statement ?? t('clusterUnclosedOverdueHypothesisTitle'),
          days: a.overdue_days,
          href: projectHref(viewer, a.project_slug, a.hypothesis_id ? `/flow?hypothesis=${a.hypothesis_id}` : '/flow'),
          crossProjectLabel: crossProjectLabel(viewer, a.project_id, a.project_slug),
        },
        days: a.overdue_days,
      });
    } else if (a.type === 'loop_overdue_goal') {
      loop.push({
        item: {
          id: a.goal_id ?? `loop_overdue_goal-${idx}`,
          kind: 'overdueGoal',
          title: a.title ?? t('clusterUnclosedOverdueGoalTitle'),
          days: a.overdue_days,
          // 유나 design:changes(2026-08-20, PR#3257) — bare `/flow?goal=`는 데스크톱에서
          // parseView 기본값이 'hypothesis'로 떨어져(flow-client.tsx parseView) focusGoalId가
          // 조용히 드롭된다(NextMakerScreen이 view==='flow'일 때만 소비). 정본 경로
          // handleNavigateToGoal(flow-client.tsx)이 이미 view=flow를 명시 세팅하는 것과 동형으로
          // 딥링크도 명시한다.
          href: projectHref(viewer, a.project_slug, a.goal_id ? `/flow?view=flow&goal=${a.goal_id}` : '/flow'),
          crossProjectLabel: crossProjectLabel(viewer, a.project_id, a.project_slug),
        },
        days: a.overdue_days,
      });
    } else if (a.type === 'loop_outcome_missing_goal') {
      loop.push({
        item: {
          id: a.goal_id ?? `loop_outcome_missing_goal-${idx}`,
          kind: 'outcomeMissing',
          title: a.title ?? t('clusterUnclosedOutcomeMissingTitle'),
          days: a.done_days,
          // 유나 design:changes(2026-08-20, PR#3257) — bare `/flow?goal=`는 데스크톱에서
          // parseView 기본값이 'hypothesis'로 떨어져(flow-client.tsx parseView) focusGoalId가
          // 조용히 드롭된다(NextMakerScreen이 view==='flow'일 때만 소비). 정본 경로
          // handleNavigateToGoal(flow-client.tsx)이 이미 view=flow를 명시 세팅하는 것과 동형으로
          // 딥링크도 명시한다.
          href: projectHref(viewer, a.project_slug, a.goal_id ? `/flow?view=flow&goal=${a.goal_id}` : '/flow'),
          crossProjectLabel: crossProjectLabel(viewer, a.project_id, a.project_slug),
        },
        days: a.done_days,
      });
    } else if (a.type === 'hypothesis_falsified') {
      const outcome = isRecord(a.outcome_result) ? a.outcome_result : null;
      const actual = outcome ? num(outcome['actual']) : null;
      const target = outcome ? num(outcome['target']) : null;
      falsified.push({
        item: {
          id: a.hypothesis_id ?? `hypothesis_falsified-${idx}`,
          title: a.statement ?? t('signalHypothesisFalsifiedTitle'),
          target,
          actual,
          hasOutcome: actual !== null && target !== null,
          supersededId: a.superseded_by_hypothesis_id,
          href: projectHref(viewer, a.project_slug, a.hypothesis_id ? `/flow?hypothesis=${a.hypothesis_id}` : '/flow'),
          crossProjectLabel: crossProjectLabel(viewer, a.project_id, a.project_slug),
        },
        days: a.falsified_days,
      });
    } else if (a.type === 'story_stalled') {
      stalled.push({
        id: a.story_id ?? `story_stalled-${idx}`,
        title: a.title ?? t('signalStalledTitle'),
        days: a.stalled_days,
        href: projectHref(viewer, a.project_slug, a.story_id ? `/board?story=${a.story_id}` : '/board'),
        crossProjectLabel: crossProjectLabel(viewer, a.project_id, a.project_slug),
      });
    } else if (a.type === 'agent_auth_failure' && a.reason) {
      authFailure.push({
        item: {
          id: `${a.member_id ?? 'unknown'}-${a.reason}-${idx}`,
          memberId: a.member_id,
          reason: a.reason,
          failureCount: a.failure_count ?? 0,
          firstFailedAt: a.first_failed_at,
          lastFailedAt: a.last_failed_at,
        },
        lastFailedAt: a.last_failed_at,
      });
    }
  });

  // 최근순 = falsified_days 오름차순(작을수록 최근 반증). 값이 없으면(BE 미배선) 뒤로 민다.
  falsified.sort((x, y) => (x.days ?? Infinity) - (y.days ?? Infinity));
  // 일수순 = stalled_days 내림차순(오래 묵은 것 먼저, 유나 v4 mockup 예시와 동일).
  stalled.sort((x, y) => (y.days ?? -Infinity) - (x.days ?? -Infinity));
  // 루프도 정체와 동형(오래 묵을수록 위) — 도과/done 경과 둘 다 "오래 방치될수록 먼저".
  loop.sort((x, y) => (y.days ?? -Infinity) - (x.days ?? -Infinity));
  // 최근 실패부터(lastFailedAt 내림차순) — 가장 급한(지금도 진행 중일 가능성 높은) 것 먼저.
  authFailure.sort((x, y) => (y.lastFailedAt ?? '').localeCompare(x.lastFailedAt ?? ''));

  return {
    falsified: falsified.map((f) => f.item),
    stalled,
    loop: loop.map((l) => l.item),
    authFailure: authFailure.map((a) => a.item),
    // BE count 필드 3종의 합(§3 갱신, doc a8e73bdb) — items[] top-20 cap과 무관한 참값.
    // loopCounts 미제공(구 호출부·테스트) 시 loop.length로 폴백(회귀 0).
    loopTotalCount: loopCounts
      ? loopCounts.loopOverdueHypothesisCount + loopCounts.loopOverdueGoalCount + loopCounts.loopOutcomeMissingGoalCount
      : loop.length,
    measurePlanMissingGoalCount: loopCounts?.measurePlanMissingGoalCount ?? 0,
    unmeasurableGoalCount: loopCounts?.unmeasurableGoalCount ?? 0,
  };
}
