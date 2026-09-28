// @vitest-environment jsdom
// story #4336 PR2 — 작업 상태 보기 폴링: 끝(completed · failed)까지 다시 묻고, 응답을 못 받은 한 번은 건너뛰고, 화면을 떠나면(abort) 멈춘다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

import { asQueuedJob, waitForBackgroundJob } from './background-job';

const job = (status: string, extra: Record<string, unknown> = {}) => ({
  ok: true, json: async () => ({ data: { id: 'j1', kind: 'channel_video_confirm', status, result: null, error: null, ...extra } }),
});

beforeEach(() => { vi.useFakeTimers(); fetchWithAuthMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('waitForBackgroundJob', () => {
  it('⭐pending → in_progress → completed까지 묻고 끝난 작업을 돌려준다 · 같은 작업 주소', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(job('pending'))
      .mockResolvedValueOnce(job('in_progress'))
      .mockResolvedValueOnce(job('completed', { result: { video: { video_id: 'v1' } } }));
    const done = waitForBackgroundJob<{ video: { video_id: string } }>('org-1', 'j1', { intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(350);
    const result = await done;
    expect(result?.status).toBe('completed');
    expect(result?.result?.video.video_id).toBe('v1');
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
    expect(fetchWithAuthMock.mock.calls[0][0]).toBe('/api/organizations/org-1/background-jobs/j1');
  });

  it('⭐failed도 끝 — 요청이 받았을 본문(error)을 그대로', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(job('failed', { error: { status_code: 422, detail: { code: 'CHANNEL_VIDEO_DURATION_EXCEEDED' } } }));
    const done = waitForBackgroundJob('org-1', 'j1', { intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    const result = await done;
    expect(result?.status).toBe('failed');
    expect(result?.error).toEqual({ status_code: 422, detail: { code: 'CHANNEL_VIDEO_DURATION_EXCEEDED' } });
  });

  it('응답을 못 받은 한 번(네트워크 · !ok)은 건너뛰고 계속 묻는다', async () => {
    fetchWithAuthMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce(job('completed'));
    const done = waitForBackgroundJob('org-1', 'j1', { intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(350);
    expect((await done)?.status).toBe('completed');
  });

  it('⭐화면을 떠나면(abort) 묻기를 멈추고 null', async () => {
    fetchWithAuthMock.mockResolvedValue(job('pending'));
    const controller = new AbortController();
    const done = waitForBackgroundJob('org-1', 'j1', { intervalMs: 100, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(250);
    const callsBefore = fetchWithAuthMock.mock.calls.length;
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toBeNull();
    expect(fetchWithAuthMock.mock.calls.length).toBe(callsBefore);
  });
});

describe('asQueuedJob — 같은 라우트가 바로 결과나 작업을 준다(#4336 PR2 ②)', () => {
  const queued = { id: 'j1', kind: 'loop_context_pack', status: 'pending', result: null, error: null };
  it('⭐이 종류의 안 끝난 작업이면 작업 · 바로 온 결과 · 다른 종류 · 끝난 작업은 null', () => {
    expect(asQueuedJob(queued, 'loop_context_pack')).toEqual(queued);
    expect(asQueuedJob({ ...queued, status: 'in_progress' }, 'loop_context_pack')?.id).toBe('j1');
    expect(asQueuedJob({ items: [], embed_available: true }, 'loop_context_pack')).toBeNull();
    expect(asQueuedJob(queued, 'attachment_convert')).toBeNull();
    expect(asQueuedJob({ ...queued, status: 'completed' }, 'loop_context_pack')).toBeNull();
    expect(asQueuedJob(null, 'loop_context_pack')).toBeNull();
  });
});

describe('waitForBackgroundJob — 떠난 화면(#4336 PR2 ② · 까디르 codex)', () => {
  it('⭐가던 요청에 signal을 넘기고 · 응답이 abort 뒤에 와도 끝난 작업을 넘기지 않는다(null)', async () => {
    const controller = new AbortController();
    let resolveFetch: (v: unknown) => void = () => {};
    fetchWithAuthMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const done = waitForBackgroundJob('org-1', 'j1', { intervalMs: 100, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchWithAuthMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
    controller.abort();
    resolveFetch(job('completed', { result: { video: { video_id: 'v1' } } }));
    expect(await done).toBeNull();
  });
});
