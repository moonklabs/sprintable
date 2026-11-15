import type { useTranslations } from 'next-intl';
import { formatViewerScheduledAt } from '@/lib/schedule-format';

// story #4888(UI-5 목표 화면) — 목표 화면의 타입 · 순수 도우미를 한 곳에 모은다(goals-client.tsx에서 옮김 · 동작 무변경). 목록 행 · 상세 열 · 편집 폼이 같이 쓴다.

export type GoalStatus = 'draft' | 'active' | 'done' | 'archived';
export type GoalPriority = 'critical' | 'high' | 'medium' | 'low';

export interface Story {
  id: string;
  title: string;
  status: string;
  story_points?: number;
}

export interface Goal {
  id: string;
  title: string;
  description?: string;
  status: GoalStatus;
  priority: GoalPriority;
  target_date?: string;
  target_sp?: number;
  created_at: string;
  stories?: Story[];
  success_hypothesis?: string | null;
  metric_definition?: Record<string, unknown> | null;
  measure_after?: string | null;
  // story #2958 — outcome-status-badge.tsx는 이미 unmeasured/unmeasurable을 지원했으나 이 타입엔
  // 없었다(타입 갭, 실 BE 값은 이미 이 4종 전부 낼 수 있음).
  outcome_status?: 'n_a' | 'pending' | 'hit' | 'miss' | 'unmeasured' | 'unmeasurable' | null;
  outcome_result?: Record<string, unknown> | null;
  // E1 S8b: BE EpicResponse가 list 응답에 부착하는 연결 가설 집계(미부착 경로는 기본값).
  hypothesis_count?: number;
  risky_status?: string | null;
  // 0d4c89e8: BE list 응답 story count 집계(#1527). detail/미부착 경로는 stories 폴백.
  total_stories?: number;
  done_stories?: number;
  // wedge #2(로드맵 조타·BE #2076): 큐레이션 순서(null=미조타·자동도출). source_loop_id는 Loop
  // 제안 hook — 실 배선 P3/v2, v1은 미표시(no-fiction).
  position?: number | null;
  source_loop_id?: string | null;
  // story #3126(#2341 AC1 후속) — `?include=glance` 옵트인 시에만 실린다. 이 goal 소속
  // non-done story의 updated_at 최댓값(없으면 null) — "status='active' 52개 중 몇 개가
  // «정말» 움직이는가"를 이 필드+dormancy_threshold_hours로 가른다("active" 미포함 이름).
  latest_story_activity_at?: string | null;
}

export function calcStoryProgress(stories: Story[]): { done: number; total: number } {
  const total = stories.length;
  const done = stories.filter((s) => s.status === 'done').length;
  return { done, total };
}

export function calcSpProgress(stories: Story[]): { done: number; total: number } {
  const total = stories.reduce((sum, s) => sum + (s.story_points ?? 0), 0);
  const done = stories
    .filter((s) => s.status === 'done')
    .reduce((sum, s) => sum + (s.story_points ?? 0), 0);
  return { done, total };
}

// story #3493 — measure_after/target_date는 둘 다 "약속"(측정 예정일·목표 완료일,
// 아직 안 온 미래 시점) — §11-2 정본(formatScheduledAt)으로 통일한다. locale
// 하드코딩(구 #2084 근본원인) 자체가 사라진다 — 이 정본은 tz만 받고 로케일 무관
// 고정 포맷이라 en/ko 분기가 원천적으로 없다.
export function formatDate(dateStr: string | undefined, displayTimezone: string | null): string {
  if (!dateStr) return '—';
  return formatViewerScheduledAt(dateStr, displayTimezone).display;
}

export interface GoalEditDraft { title: string; description: string; priority: GoalPriority; targetDate: string; targetSp: string }

// story #2958 §2(doc goals-outcome-ledger-redesign-handoff) — 목표별 "결과" 텍스트 줄. 실
// outcome_result는 비정형(Record<string,unknown>)이라 수치를 지어내지 않는다(§8 "데이터 있는
// 만큼만") — 라벨 재사용 + measure_after가 있으면 그 날짜만 덧붙인다(허구 금지).
export function outcomeLineText(
  t: ReturnType<typeof useTranslations<'goals'>>,
  tOutcome: ReturnType<typeof useTranslations<'outcomeLoop'>>,
  status: Goal['outcome_status'],
  measureAfter: string | null | undefined,
  displayTimezone: string | null,
): { text: string; tone: 'green' | 'blue' | 'neutral' } {
  if (status === 'hit') return { text: tOutcome('statusHit'), tone: 'green' };
  if (status === 'miss') return { text: tOutcome('statusMiss'), tone: 'neutral' };
  if (status === 'unmeasured') return { text: tOutcome('statusUnmeasured'), tone: 'neutral' };
  if (status === 'unmeasurable') return { text: tOutcome('statusUnmeasurable'), tone: 'neutral' };
  // pending/n_a/null — 아직 결과 없음. measure_after가 있으면 "측정 예정 · 날짜"까지만(추측 금지).
  if (measureAfter) return { text: `${t('outcomeAwaitingMeasure')} · ${formatDate(measureAfter, displayTimezone)}`, tone: 'blue' };
  return { text: tOutcome('statusPending'), tone: 'neutral' };
}
