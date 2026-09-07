import { describe, expect, it } from 'vitest';
import { extractBackendErrorMessage, HUMAN_SAFE_ERROR_MESSAGE_CODES } from './api-error-message';

describe('extractBackendErrorMessage — story #2647(공통화, #2637 §범위3 패턴 공유)', () => {
  it('apiSuccess() 에러 모양({error:{code,message}})에서 code가 allowlist에 있으면 뽑는다', () => {
    expect(extractBackendErrorMessage({ error: { code: 'COMMENT_REFRESH_HUMAN_ONLY', message: '댓글 재수집은 휴먼 멤버만 가능합니다.' } }))
      .toBe('댓글 재수집은 휴먼 멤버만 가능합니다.');
  });

  it('FastAPI HTTPException을 그대로 통과시키는 문자열 detail에서 뽑는다(code 없어도 §2647 계약 그대로)', () => {
    expect(extractBackendErrorMessage({ detail: 'Agent cannot mute assigned conversation or thread' }))
      .toBe('Agent cannot mute assigned conversation or thread');
  });

  it('{detail:{code,message}} 모양도 code가 allowlist에 있으면 뽑는다', () => {
    expect(extractBackendErrorMessage({ detail: { code: 'COMMENT_REPLY_HUMAN_ONLY', message: '이 액션은 휴먼 멤버만 가능합니다.' } }))
      .toBe('이 액션은 휴먼 멤버만 가능합니다.');
  });

  it('세 자리 다 없으면 null(호출부가 자기 폴백을 쓴다 — 지어내지 않음)', () => {
    expect(extractBackendErrorMessage({})).toBeNull();
    expect(extractBackendErrorMessage(null)).toBeNull();
    expect(extractBackendErrorMessage(undefined)).toBeNull();
    expect(extractBackendErrorMessage('not an object')).toBeNull();
    expect(extractBackendErrorMessage({ detail: { code: 'X' } })).toBeNull();
  });

  it('error.message 우선순위가 detail보다 높다(apiSuccess 경로가 있으면 그쪽이 정본)', () => {
    expect(extractBackendErrorMessage({
      error: { code: 'COMMENT_REFRESH_HUMAN_ONLY', message: 'A' },
      detail: 'B',
    })).toBe('A');
  });

  // story #3601(유나 Design CHANGES, 페드루 PO 정정 2026-09-07) — 핵심 처방: object 형
  // (error.message·detail.message)은 code가 HUMAN_SAFE_ERROR_MESSAGE_CODES에 없으면
  // 절대 통과시키지 않는다. uuid·내부 필드명·raw exception repr을 그대로 담는 코드가
  // 실재한다(예: COMMENT_REPLY_WRONG_STATUS "이 상태(draft)에서는…", UNSUPPORTED_
  // CONTENT_TYPE의 content_type repr) — 이 테스트가 그 gate를 고정한다.
  it('object 형인데 code가 allowlist 밖이면 message가 안전해 보여도 null(사람 이름·uuid 방지)', () => {
    expect(extractBackendErrorMessage({
      error: { code: 'COMMENT_REPLY_WRONG_STATUS', message: '이 상태(draft)에서는 상신할 수 없습니다' },
    })).toBeNull();
    expect(extractBackendErrorMessage({
      detail: { code: 'UNSUPPORTED_CONTENT_TYPE', message: "허용되지 않는 content_type: 'image/gif'" },
    })).toBeNull();
  });

  it('object 형인데 code 필드 자체가 없으면(구형 픽스처) null — code 없이는 안전성을 잴 수 없다', () => {
    expect(extractBackendErrorMessage({ error: { message: '이름 없이 온 문구' } })).toBeNull();
    expect(extractBackendErrorMessage({ detail: { message: 'Admin role required' } })).toBeNull();
  });

  it('앱 전체 미지정 404/제네릭 라벨(NOT_FOUND 등)은 목록에 없다 — uuid를 담는 다른 자리와 공유하는 라벨이라 등재 금지', () => {
    expect(HUMAN_SAFE_ERROR_MESSAGE_CODES.has('NOT_FOUND')).toBe(false);
  });
});
