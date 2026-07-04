import type { MetricDefinition } from '@sprintable/core-storage';

/**
 * E-SPRINT-LOOP FE(278314e9) — sprint-open 定 가설 선언. S16 Goal 폼(단일 가설·필수강제+L3)을
 * sprint 레벨 N-선언으로 합성(핸드오프 §설계논지). 카드 1개 = 가설 1개.
 */
export type DeclarationMode = 'new' | 'link';

export interface HypothesisDeclarationValue {
  mode: DeclarationMode;
  // mode='new'
  statement: string;
  metricDefinition: MetricDefinition | null;
  measureAfter: string;
  drafted: boolean;
  // mode='link'
  linkedHypothesisId: string | null;
  linkedPreview: { statement: string; metric?: string | null; status: string } | null;
}

export const EMPTY_DECLARATION: HypothesisDeclarationValue = {
  mode: 'new',
  statement: '',
  metricDefinition: null,
  measureAfter: '',
  drafted: false,
  linkedHypothesisId: null,
  linkedPreview: null,
};

export function isDeclarationComplete(v: HypothesisDeclarationValue): boolean {
  if (v.mode === 'link') return v.linkedHypothesisId != null;
  const md = v.metricDefinition;
  return (
    v.statement.trim().length > 0 &&
    !!md && md.metric.trim().length > 0 &&
    v.measureAfter.length > 0 &&
    (md.source !== 'ga4' || (!!md.property_id?.trim() && !!md.ga4_metric && !!md.date_range_days))
  );
}

/** POST /api/sprints/:id/hypotheses 페이로드(BE 계약 crux 중 — 신규=create+link, 기존=link만). */
export function toDeclarationPayload(v: HypothesisDeclarationValue): Record<string, unknown> | null {
  if (v.mode === 'link') {
    if (!v.linkedHypothesisId) return null;
    return { hypothesis_id: v.linkedHypothesisId };
  }
  if (!isDeclarationComplete(v)) return null;
  return {
    statement: v.statement.trim(),
    metric_definition: v.metricDefinition,
    measure_after: `${v.measureAfter}T00:00:00Z`,
  };
}

/** context-pack/search 응답(P1-S6, backend/app/schemas/context_pack.py 실측) — hypothesis_status/
 * outcome_summary는 BE story a353e88d(PR #1867, crux 중) additive nullable, 아직 미착지. */
export interface ContextPackSearchResult {
  entity_type: string;
  entity_id: string;
  embedding_text: string;
  similarity: number;
  hypothesis_status?: 'verified' | 'falsified' | null;
  outcome_summary?: string | null;
}
