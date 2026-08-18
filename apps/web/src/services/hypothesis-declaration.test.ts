import { describe, expect, it } from 'vitest';
import {
  EMPTY_DECLARATION,
  getMissingDeclarationFields,
  isDeclarationComplete,
  toDeclarationPayload,
  type HypothesisDeclarationValue,
} from './hypothesis-declaration';

describe('isDeclarationComplete / toDeclarationPayload (E-SPRINT-LOOP 278314e9)', () => {
  it('an empty declaration is incomplete (planning/draft stays free — AC "0개도 임시저장 허용")', () => {
    expect(isDeclarationComplete(EMPTY_DECLARATION)).toBe(false);
    expect(toDeclarationPayload(EMPTY_DECLARATION)).toBeNull();
  });

  it('mode=new requires statement + metric + measure_after (internal_ops)', () => {
    const v: HypothesisDeclarationValue = {
      ...EMPTY_DECLARATION,
      statement: '가격 페이지 CTA를 바꾸면 전환이 오른다',
      metricDefinition: { metric: '가입 전환율', source: 'internal_ops', target: 4, direction: 'up' },
      measureAfter: '2026-07-20',
    };
    expect(isDeclarationComplete(v)).toBe(true);
    expect(toDeclarationPayload(v)).toEqual({
      statement: v.statement,
      metric_definition: v.metricDefinition,
      measure_after: '2026-07-20T00:00:00Z',
    });
  });

  it('mode=new + source=ga4 additionally requires property_id/ga4_metric/date_range_days', () => {
    const base: HypothesisDeclarationValue = {
      ...EMPTY_DECLARATION,
      statement: 'stmt',
      measureAfter: '2026-07-20',
      metricDefinition: { metric: 'conversions', source: 'ga4', target: 4, direction: 'up' },
    };
    expect(isDeclarationComplete(base)).toBe(false); // missing GA4 fields
    const complete: HypothesisDeclarationValue = {
      ...base,
      metricDefinition: { ...base.metricDefinition!, property_id: '123', ga4_metric: 'conversions', date_range_days: 14 },
    };
    expect(isDeclarationComplete(complete)).toBe(true);
  });

  it('mode=link requires only linkedHypothesisId, payload = {hypothesis_id}', () => {
    const v: HypothesisDeclarationValue = { ...EMPTY_DECLARATION, mode: 'link', linkedHypothesisId: 'hyp-1' };
    expect(isDeclarationComplete(v)).toBe(true);
    expect(toDeclarationPayload(v)).toEqual({ hypothesis_id: 'hyp-1' });
  });

  it('mode=link without a selection is incomplete', () => {
    const v: HypothesisDeclarationValue = { ...EMPTY_DECLARATION, mode: 'link', linkedHypothesisId: null };
    expect(isDeclarationComplete(v)).toBe(false);
    expect(toDeclarationPayload(v)).toBeNull();
  });
});

describe('getMissingDeclarationFields (story #2760 — 침묵 제거)', () => {
  it('statement + metric + target 다 채워도 measureAfter가 비면 정확히 그것만 missing — 재현: PO 실측 그대로', () => {
    const v: HypothesisDeclarationValue = {
      ...EMPTY_DECLARATION,
      statement: '가격 페이지 CTA를 바꾸면 전환이 오른다',
      metricDefinition: { metric: '가입 전환율', source: 'internal_ops', target: 4, direction: 'up' },
      measureAfter: '',
    };
    expect(getMissingDeclarationFields(v)).toEqual(['measureAfter']);
    expect(isDeclarationComplete(v)).toBe(false);
  });

  it('빈 선언은 statement·metricName·measureAfter 셋 다 missing(ga4 아니므로 ga4Config 제외)', () => {
    expect(getMissingDeclarationFields(EMPTY_DECLARATION)).toEqual(['statement', 'metricName', 'measureAfter']);
  });

  it('ga4 소스인데 세부 필드 미입력이면 ga4Config가 missing 목록에 실린다', () => {
    const v: HypothesisDeclarationValue = {
      ...EMPTY_DECLARATION,
      statement: 'stmt',
      measureAfter: '2026-07-20',
      metricDefinition: { metric: 'conversions', source: 'ga4', target: 4, direction: 'up' },
    };
    expect(getMissingDeclarationFields(v)).toEqual(['ga4Config']);
  });

  it('완결된 선언은 missing 0건', () => {
    const v: HypothesisDeclarationValue = {
      ...EMPTY_DECLARATION,
      statement: 'stmt',
      metricDefinition: { metric: 'm', source: 'internal_ops', target: 4, direction: 'up' },
      measureAfter: '2026-07-20',
    };
    expect(getMissingDeclarationFields(v)).toEqual([]);
  });

  it('mode=link은 missing 개념이 없다(항상 빈 배열) — isDeclarationComplete는 linkedHypothesisId로 별도 판정', () => {
    expect(getMissingDeclarationFields({ ...EMPTY_DECLARATION, mode: 'link' })).toEqual([]);
  });
});
