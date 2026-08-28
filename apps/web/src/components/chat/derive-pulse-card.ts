/**
 * story #3178(S3b·SID 3178) — chat 구심점 「지금」 스트립 아래 고정 「프로젝트 맥박」 카드.
 * AC 뼈 = doc 「S3 와이어 심화」§2c/2d. command-center OverviewZone(project pulse)을 이사한다.
 *
 * ## AC3 항목 단위 다이어트 — 실 표면 대조 재확認(PO 구현 시점 조건, 시안 주장 그대로 안 믿음)
 *
 * 시안(s3b-pulse-card-mockup-render-20260828)의 다이어트 후보를 실물로 대조했다:
 *
 * - **소거 확定: `recent_changes`** — `/activity`(ActivityLogView, entity_type∈
 *   {story,epic,sprint,memo,task,agent_run,doc,meeting}) 페이지가 실측 라이브 확認됐고,
 *   그 액션 taxonomy가 OverviewZone의 VERB_META(story.created/status_changed·
 *   sprint.started/closed·doc.created·agent_run.completed/failed)를 그대로 포함하는
 *   상위집합이다 — 완전 중복 확定, 이 카드에서 제거.
 *
 * - **다이어트 확定(전체 목록 제거·1개로): 에픽 진척** — 시안 주장("에픽 표면과 완전
 *   중복")과 달리 `/epics`(EpicSwimlaneBoard)는 완성률(%) 표시가 아예 없는 **다른 정보
 *   형태**(스토리 카드가 배치된 칸반)라 엄밀히는 "완전 중복"이 아니었다(실측으로 반증).
 *   `/flow`의 flow-epic-nodes.tsx도 completion_pct를 안 그린다. 진짜 근거는 command-
 *   center.tsx 자기 자신의 헤더(§L74-92)가 이미 **활성 에픽 1건**(title+derivePhrase)을
 *   보여주는 것과 OverviewZone의 최대 6건 목록이 **같은 화면 안에서** 겹친다는 내부
 *   중복이었다 — 그래서 «전체 목록 삭제, 활성 에픽 1건 glance만 유지»로, command-
 *   center.tsx 헤더와 동일 패턴(derivePhrase 재사용)을 그대로 가져온다.
 *
 * - **유지 확定: 집계 지표(failed_runs·cycle_time·contribution·cost_trend)** — `/activity`·
 *   `/epics`·`/flow` 어디에도 이 넷의 집계값을 보여주는 표면이 없다(grep 재확認) — 다른
 *   표면에 없는 고유 조망이 맞다, 그대로 유지.
 *
 * 데이터원 = 기존 `/api/dashboard/overview`(Overview 타입) 재사용, 신규 BE 0.
 */
import type { Overview } from '@/components/dashboard/command-center/types';
import { isPending } from '@/components/dashboard/command-center/types';
import { derivePhrase, type ProgressPhrase } from '@/services/glance';

export interface ActiveEpicGlance {
  epicId: string;
  title: string;
  phrase: ProgressPhrase;
  completionPct: number;
}

export interface PulseCardData {
  activeEpic: ActiveEpicGlance | null;
  failedRuns: number | null; // null = BE 아직 pending_data(#2338 계약 그대로 계승)
  cycleTime: { avgDays: number | null; sample: number } | null;
  contribution: { agent: number; human: number; unassigned: number } | null;
  costTrend: { totalUsd: number; points: number[] } | null;
}

/** command-center.tsx §L69의 activeEpic 선택 로직과 동일(status==='active') — 이사한다. */
export function buildPulseCardData(overview: Overview | null): PulseCardData {
  const ps = overview?.project_status;
  const epics = ps?.epics ?? [];
  const active = epics.find((e) => e.status === 'active') ?? null;

  return {
    activeEpic: active
      ? {
          epicId: active.epic_id,
          title: active.title,
          phrase: derivePhrase(active.completion_pct, active.total),
          completionPct: active.completion_pct,
        }
      : null,
    failedRuns: ps && !isPending(ps.risk) ? ps.risk.failed_runs : null,
    cycleTime: ps && !isPending(ps.cycle_time) ? { avgDays: ps.cycle_time.avg_days, sample: ps.cycle_time.sample } : null,
    contribution: ps && !isPending(ps.contribution) ? ps.contribution : null,
    costTrend: ps && !isPending(ps.cost_trend)
      ? { totalUsd: ps.cost_trend.total_cost_usd, points: ps.cost_trend.points.map((p) => p.cost_usd) }
      : null,
  };
}

/** pulse 카드가 그릴 재료가 하나도 없으면(overview 없음·에픽 없음·전 지표 pending) 카드
 * 자체를 안 그린다 — 빈 껍데기 고정 카드가 첫 화면을 잠식하지 않게(합산 불변식과 별개로,
 * "재료 0인데 자리만 차지"하는 회귀도 막는다). */
export function isPulseCardEmpty(data: PulseCardData): boolean {
  return data.activeEpic === null
    && data.failedRuns === null
    && data.cycleTime === null
    && data.contribution === null
    && data.costTrend === null;
}
