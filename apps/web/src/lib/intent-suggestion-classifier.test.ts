import { describe, it, expect } from 'vitest';
import {
  detectApprovalIntent, detectCompletionIntent, detectAssignmentIntent,
  extractEntityRefs, firstRefOfType,
} from './intent-suggestion-classifier';

describe('intent-suggestion-classifier (story #2638)', () => {
  it('detectApprovalIntent — PO 재발 메시지 원문("승인 주시면")을 잡는다(AC1)', () => {
    expect(detectApprovalIntent('이 문서 승인 주시면 감사하겠습니다')).toBe(true);
  });

  it('detectApprovalIntent — 무관한 일상 대화(오탐 방지)엔 안 걸린다', () => {
    expect(detectApprovalIntent('오늘 결재 서류함이 좀 어지럽네요')).toBe(false);
    expect(detectApprovalIntent('그냥 확認만 해주세요')).toBe(false);
  });

  it('detectApprovalIntent — 다른 요청형 어미도 잡는다', () => {
    expect(detectApprovalIntent('결재 요청드립니다')).toBe(true);
    expect(detectApprovalIntent('상신 드립니다')).toBe(true);
  });

  it('detectCompletionIntent — 완료 보고 문구를 잡는다', () => {
    expect(detectCompletionIntent('작업 다 했습니다')).toBe(true);
    expect(detectCompletionIntent('완료 보고드립니다')).toBe(true);
  });

  it('detectAssignmentIntent — 배정 문구를 잡는다', () => {
    expect(detectAssignmentIntent('이 작업 배정할게요')).toBe(true);
    expect(detectAssignmentIntent('맡아주세요')).toBe(true);
  });

  it('extractEntityRefs — entity 토큰을 type/id로 뽑는다(chat-bubble.tsx 렌더 정규식과 동일 계약)', () => {
    const content = '[제목](entity:doc:11111111-1111-1111-1111-111111111111) 승인 주시면';
    expect(extractEntityRefs(content)).toEqual([
      { type: 'doc', id: '11111111-1111-1111-1111-111111111111' },
    ]);
  });

  it('extractEntityRefs — 토큰 없으면 빈 배열', () => {
    expect(extractEntityRefs('그냥 텍스트')).toEqual([]);
    expect(extractEntityRefs(null)).toEqual([]);
  });

  it('firstRefOfType — 지정 타입 중 첫 매치만', () => {
    const refs = [
      { type: 'story', id: 's1' },
      { type: 'doc', id: 'd1' },
      { type: 'doc', id: 'd2' },
    ];
    expect(firstRefOfType(refs, ['doc'])).toEqual({ type: 'doc', id: 'd1' });
    expect(firstRefOfType(refs, ['task'])).toBeNull();
  });
});
