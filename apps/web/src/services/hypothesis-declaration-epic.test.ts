import { describe, expect, it } from 'vitest';
import { EMPTY_DECLARATION, type HypothesisDeclarationValue } from './hypothesis-declaration';
import { toEpicHypothesisCreatePayload, toEpicHypothesisLink } from './hypothesis-declaration-epic';

describe('toEpicHypothesisCreatePayload / toEpicHypothesisLink (story 671ea3b8)', () => {
  it('an empty declaration produces neither a create payload nor a link', () => {
    expect(toEpicHypothesisCreatePayload(EMPTY_DECLARATION, 'proj-1', 'epic-1')).toBeNull();
    expect(toEpicHypothesisLink(EMPTY_DECLARATION, 'epic-1')).toBeNull();
  });

  it('mode=new maps to POST /api/hypotheses body with epic_ids+source_type=epic (no sprint-only endpoint reuse — grounding: epics have no /epics/:id/hypotheses route)', () => {
    const v: HypothesisDeclarationValue = {
      ...EMPTY_DECLARATION,
      statement: '온보딩 단축이 첫 주 이탈을 줄인다',
      metricDefinition: { metric: '7일 잔존율', source: 'internal_ops', target: 60, direction: 'up' },
      measureAfter: '2026-08-01',
    };
    expect(toEpicHypothesisCreatePayload(v, 'proj-1', 'epic-1')).toEqual({
      project_id: 'proj-1',
      statement: v.statement,
      metric_definition: v.metricDefinition,
      measure_after: '2026-08-01T00:00:00Z',
      epic_ids: ['epic-1'],
      source_type: 'epic',
      source_id: 'epic-1',
    });
  });

  it('mode=new + source=ga4 without the GA4 fields is incomplete (matches isDeclarationComplete — no separate validation logic to drift)', () => {
    const v: HypothesisDeclarationValue = {
      ...EMPTY_DECLARATION,
      statement: 'stmt',
      measureAfter: '2026-08-01',
      metricDefinition: { metric: 'conversions', source: 'ga4', target: 4, direction: 'up' },
    };
    expect(toEpicHypothesisCreatePayload(v, 'proj-1', 'epic-1')).toBeNull();
  });

  it('mode=link maps to a links-endpoint call targeting the linked hypothesis id, scoped to the new epic', () => {
    const v: HypothesisDeclarationValue = { ...EMPTY_DECLARATION, mode: 'link', linkedHypothesisId: 'hyp-9' };
    expect(toEpicHypothesisCreatePayload(v, 'proj-1', 'epic-1')).toBeNull(); // link mode never produces a create payload
    expect(toEpicHypothesisLink(v, 'epic-1')).toEqual({ hypothesisId: 'hyp-9', payload: { epic_ids: ['epic-1'] } });
  });

  it('mode=link without a selection produces neither', () => {
    const v: HypothesisDeclarationValue = { ...EMPTY_DECLARATION, mode: 'link', linkedHypothesisId: null };
    expect(toEpicHypothesisCreatePayload(v, 'proj-1', 'epic-1')).toBeNull();
    expect(toEpicHypothesisLink(v, 'epic-1')).toBeNull();
  });
});
