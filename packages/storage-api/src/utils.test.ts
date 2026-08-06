// story #2488 — mapApiError가 404/403 외 status·error.code를 discard하던 병 회귀가드.
import { describe, expect, it } from 'vitest';
import { NotFoundError, ForbiddenError } from '@sprintable/core-storage';
import { mapApiError } from './utils';

describe('mapApiError (story #2488)', () => {
  it('404 — NotFoundError instanceof 유지 + code/status 보존', () => {
    const err = mapApiError(404, { error: { code: 'STORY_NOT_FOUND', message: 'Story not found' } });
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe('Story not found');
    expect(err.code).toBe('STORY_NOT_FOUND');
    expect(err.status).toBe(404);
  });

  it('403 — ForbiddenError instanceof 유지 + code/status 보존', () => {
    const err = mapApiError(403, { error: { code: 'FORBIDDEN', message: 'No access' } });
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.status).toBe(403);
  });

  it('그 외(422) — 이전엔 generic Error(message만)로 뭉갰다. 이제 code·status가 보존된다(핵심 회귀가드)', () => {
    const err = mapApiError(422, { error: { code: 'HYPOTHESIS_REQUIRED_FOR_ACTIVATION', message: 'Hypothesis required' } });
    expect(err.message).toBe('Hypothesis required');
    expect(err.code).toBe('HYPOTHESIS_REQUIRED_FOR_ACTIVATION');
    expect(err.status).toBe(422);
  });

  it('402 PLAN_LIMIT_EXCEEDED도 동일하게 보존된다', () => {
    const err = mapApiError(402, { error: { code: 'PLAN_LIMIT_EXCEEDED', message: 'Free plan project limit reached.' } });
    expect(err.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(err.status).toBe(402);
  });

  it('backend가 code를 안 준 경우 — HTTP_{status} 폴백 code(raw message는 그대로 보존, 상위에서 사용 여부 결정)', () => {
    const err = mapApiError(500, { error: { message: 'Internal server error' } });
    expect(err.code).toBe('HTTP_500');
    expect(err.status).toBe(500);
  });

  it('body 자체가 없을 때도 안전 폴백(HTTP {status} message)', () => {
    const err = mapApiError(500, {});
    expect(err.message).toBe('HTTP 500');
    expect(err.code).toBe('HTTP_500');
  });
});
