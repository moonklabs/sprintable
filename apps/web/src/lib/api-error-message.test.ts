import { describe, expect, it } from 'vitest';
import { extractBackendErrorMessage } from './api-error-message';

describe('extractBackendErrorMessage — story #2647(공통화, #2637 §범위3 패턴 공유)', () => {
  it('apiSuccess() 에러 모양({error:{message}})에서 그대로 뽑는다', () => {
    expect(extractBackendErrorMessage({ error: { message: '이 이벤트는 human 발행자만 허용합니다.' } }))
      .toBe('이 이벤트는 human 발행자만 허용합니다.');
  });

  it('FastAPI HTTPException을 그대로 통과시키는 문자열 detail에서 뽑는다', () => {
    expect(extractBackendErrorMessage({ detail: 'Agent cannot mute assigned conversation or thread' }))
      .toBe('Agent cannot mute assigned conversation or thread');
  });

  it('{detail:{message}} 모양에서도 뽑는다', () => {
    expect(extractBackendErrorMessage({ detail: { message: 'Admin role required' } })).toBe('Admin role required');
  });

  it('세 자리 다 없으면 null(호출부가 자기 폴백을 쓴다 — 지어내지 않음)', () => {
    expect(extractBackendErrorMessage({})).toBeNull();
    expect(extractBackendErrorMessage(null)).toBeNull();
    expect(extractBackendErrorMessage(undefined)).toBeNull();
    expect(extractBackendErrorMessage('not an object')).toBeNull();
    expect(extractBackendErrorMessage({ detail: { code: 'X' } })).toBeNull();
  });

  it('error.message 우선순위가 detail보다 높다(apiSuccess 경로가 있으면 그쪽이 정본)', () => {
    expect(extractBackendErrorMessage({ error: { message: 'A' }, detail: 'B' })).toBe('A');
  });
});
