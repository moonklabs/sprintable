import type { MetricDefinition } from '@sprintable/core-storage';
import type { HypothesisDeclarationValue } from './hypothesis-declaration';
import { isDeclarationComplete } from './hypothesis-declaration';

/**
 * story 671ea3b8(S4) — 에픽 생성 시 가설 선언 페이로드. 스프린트 쪽(`hypothesis-declaration.ts`
 * `toDeclarationPayload`)은 `POST /sprints/:id/hypotheses`(스프린트 전용 배선 엔드포인트)를 쏘지만
 * 에픽은 그 동형 엔드포인트가 없다(그라운딩 확인 — `backend/app/routers/epics.py`에 `hypothes` 0건).
 * 대신 범용 `POST /api/hypotheses`(project_id+epic_ids로 생성 시점 링크 지원·BE 기존재)와
 * `POST /api/hypotheses/:id/links`(기존 가설 링크·BE 기존재)를 그대로 재사용한다 — 신규 BE 0.
 *
 * ⚠️에픽엔 스프린트의 `HYPOTHESIS_REQUIRED_FOR_ACTIVATION` 동형 하드게이트가 BE에 없다(그라운딩
 * 확인 — `backend/app/services/*epic*`에 해당 검사 0건). 새 게이트를 여기서 지어내지 않는다
 * (no-fiction·신규 BE 0 준수) — 에픽 쪽은 마찰 0 유도(기본 스텝으로 두되 "나중에 정합니다"로
 * 완전 스킵 가능)까지만, 활성화 시점 재확인은 없음.
 */

export interface EpicHypothesisCreatePayload {
  project_id: string;
  statement: string;
  metric_definition: MetricDefinition;
  measure_after: string;
  epic_ids: string[];
  source_type: 'epic';
  source_id: string;
}

/** mode='new' 완결 선언 → `POST /api/hypotheses` 페이로드(생성+에픽 링크 한 번에). */
export function toEpicHypothesisCreatePayload(
  v: HypothesisDeclarationValue,
  projectId: string,
  epicId: string,
): EpicHypothesisCreatePayload | null {
  if (v.mode !== 'new' || !isDeclarationComplete(v) || !v.metricDefinition) return null;
  return {
    project_id: projectId,
    statement: v.statement.trim(),
    metric_definition: v.metricDefinition,
    measure_after: `${v.measureAfter}T00:00:00Z`,
    epic_ids: [epicId],
    source_type: 'epic',
    source_id: epicId,
  };
}

export interface EpicHypothesisLink {
  hypothesisId: string;
  payload: { epic_ids: string[] };
}

/** mode='link' 완결 선언 → `POST /api/hypotheses/:hypothesisId/links` 호출 정보(기존 가설을 새 에픽에 링크). */
export function toEpicHypothesisLink(v: HypothesisDeclarationValue, epicId: string): EpicHypothesisLink | null {
  if (v.mode !== 'link' || !v.linkedHypothesisId) return null;
  return { hypothesisId: v.linkedHypothesisId, payload: { epic_ids: [epicId] } };
}
