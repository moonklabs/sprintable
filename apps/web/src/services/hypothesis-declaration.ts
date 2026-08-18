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

export type MissingDeclarationField = 'statement' | 'metricName' | 'measureAfter' | 'ga4Config';

/**
 * story #2760 — mode='new' 카드가 왜 "선언됨"으로 안 잡히는지 필드 단위로 쪼갠다(무설명
 * disabled 금지). isDeclarationComplete가 이걸로 재정의돼 있어 두 함수의 조건이 갈라질 수
 * 없다(단일 SSOT — 조건을 늘릴 땐 여기 한 곳만 고치면 카드 캡션도 자동으로 따라온다).
 */
export function getMissingDeclarationFields(v: HypothesisDeclarationValue): MissingDeclarationField[] {
  if (v.mode === 'link') return [];
  const md = v.metricDefinition;
  const missing: MissingDeclarationField[] = [];
  if (v.statement.trim().length === 0) missing.push('statement');
  if (!md || md.metric.trim().length === 0) missing.push('metricName');
  if (v.measureAfter.length === 0) missing.push('measureAfter');
  if (md?.source === 'ga4' && !(md.property_id?.trim() && md.ga4_metric && md.date_range_days)) {
    missing.push('ga4Config');
  }
  return missing;
}

export function isDeclarationComplete(v: HypothesisDeclarationValue): boolean {
  if (v.mode === 'link') return v.linkedHypothesisId != null;
  return getMissingDeclarationFields(v).length === 0;
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
