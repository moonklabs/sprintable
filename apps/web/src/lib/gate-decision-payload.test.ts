import { describe, expect, it } from 'vitest';
import { buildGateTransitionBody, buildHitlDecisionBody, classifyGateTransitionErrorCode } from './gate-decision-payload';

describe('buildGateTransitionBody — approvals-queue.tsx와 byte-동일 계약', () => {
  it('note 없음·evidenceViewed 없음·reviewedHeadSha 없음 → 전부 안전 기본값', () => {
    expect(buildGateTransitionBody({ status: 'approved' })).toEqual({
      status: 'approved', note: null, evidence_viewed: false, reviewed_head_sha: null,
    });
  });

  it('note 공백만 있으면 trim 후 null(approvals-queue.tsx 기존 note?.trim() || null과 동형)', () => {
    expect(buildGateTransitionBody({ status: 'rejected', note: '   ' }).note).toBeNull();
  });

  it('evidenceViewed·reviewedHeadSha가 있으면 그대로 실린다', () => {
    expect(buildGateTransitionBody({
      status: 'approved', note: '검토함', evidenceViewed: true, reviewedHeadSha: 'abc123',
    })).toEqual({ status: 'approved', note: '검토함', evidence_viewed: true, reviewed_head_sha: 'abc123' });
  });
});

describe('buildGateTransitionBody — story #4190 본 초안 버전', () => {
  it('reviewedDraft가 있으면 reviewed_draft_id·reviewed_draft_version으로 실린다', () => {
    expect(buildGateTransitionBody({
      status: 'approved', evidenceViewed: true, reviewedDraft: { id: 'd-1', version: 3 },
    })).toEqual({
      status: 'approved', note: null, evidence_viewed: true, reviewed_head_sha: null,
      reviewed_draft_id: 'd-1', reviewed_draft_version: 3,
    });
  });
  it('reviewedDraft가 null이면 키 자체가 안 실린다(다른 게이트 바디 byte-동일)', () => {
    expect(Object.keys(buildGateTransitionBody({ status: 'approved', reviewedDraft: null }))).toEqual([
      'status', 'note', 'evidence_viewed', 'reviewed_head_sha',
    ]);
  });
});

describe('buildHitlDecisionBody — response_text 미전달 시 키 자체가 안 실린다', () => {
  it('responseText 없음 → {status}만(approvals-queue.tsx 기존 호출과 byte-동일)', () => {
    expect(buildHitlDecisionBody({ status: 'approved' })).toEqual({ status: 'approved' });
  });

  it('responseText가 있으면 response_text로 실린다', () => {
    expect(buildHitlDecisionBody({ status: 'rejected', responseText: '아니요' })).toEqual({
      status: 'rejected', response_text: '아니요',
    });
  });
});

describe('classifyGateTransitionErrorCode', () => {
  it('gate_head_changed → head_changed', () => {
    expect(classifyGateTransitionErrorCode('gate_head_changed')).toBe('head_changed');
  });
  it('gate_draft_changed → draft_changed(story #4190)', () => {
    expect(classifyGateTransitionErrorCode('gate_draft_changed')).toBe('draft_changed');
  });
  it('gate_already_resolved → already_resolved', () => {
    expect(classifyGateTransitionErrorCode('gate_already_resolved')).toBe('already_resolved');
  });
  it('그 외(undefined·null·무관 코드) → generic', () => {
    expect(classifyGateTransitionErrorCode(undefined)).toBe('generic');
    expect(classifyGateTransitionErrorCode(null)).toBe('generic');
    expect(classifyGateTransitionErrorCode('validation_error')).toBe('generic');
  });
});
