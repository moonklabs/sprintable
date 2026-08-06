// story #2488 — handleApiError 회귀가드:
// ① NotFoundError/ForbiddenError class-identity 통일(services/sprint.ts가 이제
//    core-storage 것을 재-export) — 예전엔 로컬 동명 클래스를 봐서 mapApiError가
//    던진 core-storage 인스턴스의 instanceof가 항상 실패, 조용히 generic 400으로 샜다.
// ② mapApiError가 실은 code·status(story #2488 본 fix) — 그 값을 JSON 응답에 실어
//    브라우저까지 전달하는지.
// ③ 기존 Postgrest 코드 매핑(42501/PGRST116) 회귀 없음.
import { describe, expect, it } from 'vitest';
import { NotFoundError as CoreNotFoundError, ForbiddenError as CoreForbiddenError } from '@sprintable/core-storage';
import { mapApiError } from '@sprintable/storage-api';
import { handleApiError } from './api-error';

describe('handleApiError (story #2488)', () => {
  it('core-storage NotFoundError를 instanceof로 정확히 잡는다(class-identity 통일 회귀가드)', async () => {
    const res = handleApiError(new CoreNotFoundError('Story not found'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Story not found');
  });

  it('core-storage ForbiddenError를 instanceof로 정확히 잡는다', async () => {
    const res = handleApiError(new CoreForbiddenError('No access'));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('mapApiError(422, HYPOTHESIS_REQUIRED_FOR_ACTIVATION)가 그대로 JSON 응답에 도달한다(핵심 양성대조)', async () => {
    const err = mapApiError(422, { error: { code: 'HYPOTHESIS_REQUIRED_FOR_ACTIVATION', message: 'Hypothesis required' } });
    const res = handleApiError(err);
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('HYPOTHESIS_REQUIRED_FOR_ACTIVATION');
    expect(body.error.message).toBe('Hypothesis required');
  });

  it('mapApiError(402, PLAN_LIMIT_EXCEEDED)도 동일하게 도달한다', async () => {
    const err = mapApiError(402, { error: { code: 'PLAN_LIMIT_EXCEEDED', message: 'Free plan project limit reached.' } });
    const res = handleApiError(err);
    expect(res.status).toBe(402);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('Postgrest 42501 매핑 회귀 없음', async () => {
    const res = handleApiError({ code: '42501', message: 'x' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });

  it('Postgrest PGRST116 매핑 회귀 없음', async () => {
    const res = handleApiError({ code: 'PGRST116', message: 'x' });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('알려지지 않은 plain Error — generic INTERNAL_ERROR(400) 폴백 회귀 없음', async () => {
    const res = handleApiError(new Error('boom'));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('boom');
  });
});
