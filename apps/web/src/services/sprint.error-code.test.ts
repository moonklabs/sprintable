// story #2488 — 양성대조: mapApiError(packages/storage-api)가 이제 code·status를
// 보존하고, handleApiError(api-error.ts)가 그걸 JSON 응답에 실어 브라우저까지
// 전달하는 전체 체인을 검증한다. SprintService.activate()가 실제로 이 체인을 타는
// 자리(HYPOTHESIS_REQUIRED_FOR_ACTIVATION, #2484/#2485 그라운딩이 "죽은 분기"로
// 지목했던 바로 그 케이스)로 end-to-end 확인한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SprintService } from './sprint';
import { ApiSprintRepository } from '@sprintable/storage-api';
import { handleApiError } from '@/lib/api-error';

describe('SprintService.activate → mapApiError → handleApiError (story #2488 양성대조)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      const method = init?.method ?? 'GET';
      if (u.includes('/api/v2/sprints/sprint-1') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'sprint-1', status: 'planning', project_id: 'proj-1', title: 'Sprint 1' }),
        } as Response;
      }
      if (u.includes('/api/v2/sprints?') && method === 'GET') {
        return { ok: true, status: 200, json: async () => [] } as Response;
      }
      if (u.includes('/api/v2/sprints/sprint-1') && method === 'PATCH') {
        return {
          ok: false,
          status: 422,
          json: async () => ({
            data: null,
            error: { code: 'HYPOTHESIS_REQUIRED_FOR_ACTIVATION', message: 'At least one hypothesis must be defined before activating this sprint.' },
            meta: null,
          }),
        } as Response;
      }
      throw new Error('unexpected fetch: ' + u + ' ' + method);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('code·status가 mapApiError를 거쳐 던진 에러 객체까지 도달한다', async () => {
    const repo = new ApiSprintRepository('token-1');
    const service = new SprintService(repo, undefined, 'token-1');

    await expect(service.activate('sprint-1')).rejects.toMatchObject({
      code: 'HYPOTHESIS_REQUIRED_FOR_ACTIVATION',
      status: 422,
    });
  });

  it('그 에러가 handleApiError를 거쳐 브라우저로 갈 JSON 응답까지 code·status 그대로 도달한다(#2484/#2485 죽은 분기의 전제 fix)', async () => {
    const repo = new ApiSprintRepository('token-1');
    const service = new SprintService(repo, undefined, 'token-1');

    let caught: unknown;
    try {
      await service.activate('sprint-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();

    const res = handleApiError(caught);
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('HYPOTHESIS_REQUIRED_FOR_ACTIVATION');
    expect(body.error.message).toContain('hypothesis must be defined');
  });
});
