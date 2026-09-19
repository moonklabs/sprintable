import { describe, expect, it } from 'vitest';
import {
  deriveTrustStage, pickRelevantMergeGate,
  asMaterialCollectionSheet, asConceptBrief, asStoryboard, asAnimatic,
  isProductionWorkbenchKind, PRODUCTION_WORKBENCH_KIND_ORDER,
} from './verify';

describe('deriveTrustStage (claimed-vs-verified-spec-handoff §3 파생 규칙)', () => {
  it('returns "verified" when human_verified is true (green 무결성 — human_verified가 유일한 green 조건)', () => {
    expect(deriveTrustStage({ human_verified: true, self_reported: true })).toBe('verified');
  });

  it('returns "claimed" when self_reported is true but human_verified is not', () => {
    expect(deriveTrustStage({ self_reported: true, human_verified: null })).toBe('claimed');
    expect(deriveTrustStage({ self_reported: true, human_verified: false })).toBe('claimed');
  });

  it('returns null (무표시) when self_reported is falsy — D-03 완료 기준(증거 없는 Done은 승격 불가)', () => {
    expect(deriveTrustStage({ self_reported: null, human_verified: null })).toBeNull();
    expect(deriveTrustStage({})).toBeNull();
  });

  it('never returns "claimed" when human_verified is true, even if self_reported is somehow false (verified takes precedence)', () => {
    expect(deriveTrustStage({ self_reported: false, human_verified: true })).toBe('verified');
  });
});

// story #2933 H3(P0-H 정직성 감사) — deriveInFlightTrustChip(구 in-flight 칩 gate-목록 재파생)
// 은 story-detail-panel.tsx의 유일한 소비처를 잃고 폐기됐다(story.trust_stage로 수렴, BE
// derive_trust_stage() SoT 하나만 남김). 이 describe 블록도 함께 제거 — 죽은 함수의 테스트를
// 남겨두면 "아직 쓰인다"는 착시가 생긴다.

// story #2893(설계안 §2 A1) — 스토리당 merge 게이트가 여러 개(PR마다 1개)일 수 있다.
describe('pickRelevantMergeGate (story #2893 — PR단위 게이트 중 하나를 고르는 축)', () => {
  it('non-merge gate_type은 후보에서 제외한다', () => {
    expect(pickRelevantMergeGate([{ gate_type: 'doc_approval', status: 'pending', pr_number: null }])).toBeUndefined();
  });

  it('merge 게이트가 없으면 undefined(정직 — 지어내지 않음)', () => {
    expect(pickRelevantMergeGate([])).toBeUndefined();
  });

  it('미종결(pending/auto_passed/held)이 종결(approved/rejected/voided)보다 우선', () => {
    const approved = { gate_type: 'merge', status: 'approved', pr_number: 999 };
    const pending = { gate_type: 'merge', status: 'pending', pr_number: 1 };
    expect(pickRelevantMergeGate([approved, pending])).toBe(pending);
  });

  it('동순위(둘 다 미종결)면 pr_number가 큰 쪽(최근 PR로 근사)이 우선', () => {
    const older = { gate_type: 'merge', status: 'pending', pr_number: 101 };
    const newer = { gate_type: 'merge', status: 'pending', pr_number: 102 };
    expect(pickRelevantMergeGate([older, newer])).toBe(newer);
  });

  it('pr_number가 null인 게이트는 최하순위(실 PR 정보가 있는 쪽을 우선)', () => {
    const noPr = { gate_type: 'merge', status: 'pending', pr_number: null };
    const withPr = { gate_type: 'merge', status: 'pending', pr_number: 5 };
    expect(pickRelevantMergeGate([noPr, withPr])).toBe(withPr);
  });
});

// story #4041(제작 작업대 계약 v0.5, doc 3cca821b §4) — asVerificationSheet와 동형인
// 나머지 4개 kind narrowing. 서버가 shape을 검증하므로(#4042 대기 중이라도) FE는 최소
// 구조(kind 일치 + 필수 배열/필드 존재)만 좁히고 항목 내부까지 깊게 재검증하지 않는다.
describe('asMaterialCollectionSheet (story #4041 §4)', () => {
  it('kind가 일치하고 items가 배열이면 그대로 narrowing한다', () => {
    const payload = { kind: 'material_collection_sheet', items: [{ ref: 'https://x', label: '레퍼런스', tag: 'mood' }] };
    expect(asMaterialCollectionSheet(payload)).toEqual(payload.items);
  });

  it('kind가 다르면 null(다른 kind의 payload를 잘못 narrowing하지 않는다)', () => {
    expect(asMaterialCollectionSheet({ kind: 'concept_brief', items: [] })).toBeNull();
  });

  it('payload 자체가 없으면 null(지어내지 않음)', () => {
    expect(asMaterialCollectionSheet(null)).toBeNull();
    expect(asMaterialCollectionSheet(undefined)).toBeNull();
  });

  it('items가 배열이 아니면 null(구조 미달, no-fiction)', () => {
    expect(asMaterialCollectionSheet({ kind: 'material_collection_sheet', items: 'not-an-array' })).toBeNull();
  });
});

describe('asConceptBrief (story #4041 §4)', () => {
  it('concept·rationale 필수 필드가 문자열이면 narrowing한다', () => {
    const payload = { kind: 'concept_brief', concept: '따뜻한 톤', rationale: '타겟 반응 근거' };
    expect(asConceptBrief(payload)).toEqual({ concept: '따뜻한 톤', rationale: '타겟 반응 근거' });
  });

  it('mood_refs는 옵셔널 — 있으면 포함, 없으면 필드 자체를 안 만든다(부재≠빈 배열)', () => {
    const withRefs = asConceptBrief({ kind: 'concept_brief', concept: 'c', rationale: 'r', mood_refs: ['a', 'b'] });
    expect(withRefs).toEqual({ concept: 'c', rationale: 'r', mood_refs: ['a', 'b'] });
    const withoutRefs = asConceptBrief({ kind: 'concept_brief', concept: 'c', rationale: 'r' });
    expect(withoutRefs).not.toHaveProperty('mood_refs');
  });

  it('concept·rationale 중 하나라도 문자열이 아니면 null', () => {
    expect(asConceptBrief({ kind: 'concept_brief', concept: 123, rationale: 'r' })).toBeNull();
    expect(asConceptBrief({ kind: 'concept_brief', concept: 'c' })).toBeNull();
  });
});

describe('asStoryboard (story #4041 §4, 댄 실증 §2-2 라이브 페이로드 형)', () => {
  it('shot_list·emotion_beats가 배열이면 narrowing하고, layout_artifact_id는 있으면만 포함', () => {
    const shotList = [{ shot_no: 1, angle: 'wide', duration_sec: 3.5, desc: '오프닝' }];
    const emotionBeats = [{ beat_no: 1, shot_no: 1, emotion: 'hope' }];
    const payload = { kind: 'storyboard', shot_list: shotList, emotion_beats: emotionBeats };
    expect(asStoryboard(payload)).toEqual({ shot_list: shotList, emotion_beats: emotionBeats });
    expect(asStoryboard(payload)).not.toHaveProperty('layout_artifact_id');
    const withLayout = { ...payload, layout_artifact_id: 'uuid-1' };
    expect(asStoryboard(withLayout)).toEqual({ shot_list: shotList, emotion_beats: emotionBeats, layout_artifact_id: 'uuid-1' });
  });

  it('shot_list나 emotion_beats가 배열이 아니면 null', () => {
    expect(asStoryboard({ kind: 'storyboard', shot_list: [], emotion_beats: 'x' })).toBeNull();
    expect(asStoryboard({ kind: 'storyboard', shot_list: 'x', emotion_beats: [] })).toBeNull();
  });
});

describe('asAnimatic (story #4041 §4, cost_tier=no_charge가 ⓑ구조 게이트 판정 축)', () => {
  it('artifact_id·cost_tier·duration_sec 전부 유효하면 narrowing한다', () => {
    const payload = { kind: 'animatic', artifact_id: 'uuid-1', cost_tier: 'no_charge', duration_sec: 12.0 };
    expect(asAnimatic(payload)).toEqual({ artifact_id: 'uuid-1', cost_tier: 'no_charge', duration_sec: 12.0 });
  });

  it('cost_tier가 no_charge/paid 밖의 값이면 null(지어내지 않음 — 서버 계약 밖 값)', () => {
    expect(asAnimatic({ kind: 'animatic', artifact_id: 'x', cost_tier: 'free', duration_sec: 1 })).toBeNull();
  });

  it('필수 필드 타입이 틀리면 null', () => {
    expect(asAnimatic({ kind: 'animatic', artifact_id: 'x', cost_tier: 'paid', duration_sec: '12' })).toBeNull();
  });
});

describe('isProductionWorkbenchKind / PRODUCTION_WORKBENCH_KIND_ORDER (story #4041 §3 stage 순서)', () => {
  it('§3 매핑표 5종을 그 순서 그대로 갖는다(소재 수집→컨셉→스토리보드→애니매틱→검증)', () => {
    expect(PRODUCTION_WORKBENCH_KIND_ORDER).toEqual([
      'material_collection_sheet', 'concept_brief', 'storyboard', 'animatic', 'verification_sheet',
    ]);
  });

  it('5종 안의 kind는 true, 밖의 kind(#4042 미등재분 포함)는 false', () => {
    expect(isProductionWorkbenchKind('storyboard')).toBe(true);
    expect(isProductionWorkbenchKind('generation_cost')).toBe(false);
    expect(isProductionWorkbenchKind(undefined)).toBe(false);
    expect(isProductionWorkbenchKind(123)).toBe(false);
  });
});
