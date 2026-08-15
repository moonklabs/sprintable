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

  // PO 라이브 판정 RED(2026-08-15) 회귀가드 — 정본 토큰(reference_token.py:_escape_title)은
  // 제목의 \ [ ] ( ) 를 전부 백슬래시 이스케이프한다. 처음 심은 표본이 전부 "제목"류 무괄호
  // 였던 탓에 이 케이스를 못 잡았다("심은 표본엔 아는 종류만" — PO 교훈). QA 폐기용 문서류
  // ("[QA·폐기용] ...")가 실제 재현 사례였다.
  it('extractEntityRefs — 제목에 대괄호가 든 정본 이스케이프 토큰(실 재현 사례)도 매치한다', () => {
    const id = 'aabbccdd-1111-1111-1111-111111111111';
    const content = `[\\[QA·폐기용\\] #2668 확認용 문서](entity:doc:${id}) 승인 주시면`;
    expect(extractEntityRefs(content)).toEqual([{ type: 'doc', id }]);
  });

  it('extractEntityRefs — 제목에 괄호·백슬래시가 섞여도(이스케이프 5종 전부) 매치한다', () => {
    const id = 'aabbccdd-2222-2222-2222-222222222222';
    // 원제목: `기획(안) [v2] 검토\완료` → _escape_title이 ( ) [ ] \ 를 전부 이스케이프.
    const content = `[기획\\(안\\) \\[v2\\] 검토\\\\완료](entity:doc:${id})`;
    expect(extractEntityRefs(content)).toEqual([{ type: 'doc', id }]);
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
