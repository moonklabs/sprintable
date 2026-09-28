// @vitest-environment jsdom
// story #4336 PR2 ②(PO 04:32Z) — 회고 종합은 늘 작업: 202 + 작업 → 작업 상태 보기의 result.session(예전 200 본문 모양).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, waitForBackgroundJobMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn(), waitForBackgroundJobMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));
vi.mock('@/lib/background-job', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  waitForBackgroundJob: (...args: unknown[]) => waitForBackgroundJobMock(...args),
}));

import { requestRetroSynthesis } from './retro-synthesis-request';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

const SESSION = { synthesis: { learned: [{ text: '배운 것', source: 's' }] }, next_hypotheses: [{ statement: '다음' }] };
const QUEUED = { id: 'job-1', kind: 'retro_synthesis', status: 'pending', result: null, error: null };
const respond = (data: unknown, status = 200) => fetchWithAuthMock.mockImplementation(async () => new Response(JSON.stringify({ data }), { status }));
const args = { sessionId: 's-1', projectId: 'p-1', orgId: 'org-1' };

beforeEach(() => { fetchWithAuthMock.mockReset(); waitForBackgroundJobMock.mockReset(); });

describe('requestRetroSynthesis', () => {
  it('⭐202 + 작업 → 작업이 끝나면 result.session의 종합 · 추천 · 같은 BFF 주소 · 표 시한', async () => {
    respond(QUEUED, 202);
    waitForBackgroundJobMock.mockResolvedValue({ ...QUEUED, status: 'completed', result: { session: SESSION } });
    const out = await requestRetroSynthesis(args);
    expect(out).toEqual({ synthesis: SESSION.synthesis, next_hypotheses: SESSION.next_hypotheses });
    expect(fetchWithAuthMock.mock.calls[0][0]).toBe('/api/retro-sessions/s-1/synthesis?project_id=p-1');
    expect(fetchWithAuthMock.mock.calls[0][1]).toMatchObject({ method: 'POST', timeoutMs: LONG_ROUTES.retroSynthesis.browserMs });
    expect(waitForBackgroundJobMock.mock.calls[0].slice(0, 2)).toEqual(['org-1', 'job-1']);
  });

  it('작업 실패(예전 502 본문) · 화면을 떠남(null) · 요청 실패 · orgId 없음은 null(«종합 생성 실패» 자리)', async () => {
    respond(QUEUED, 202);
    waitForBackgroundJobMock.mockResolvedValue({ ...QUEUED, status: 'failed', error: { status_code: 502, detail: { code: 'SYNTHESIS_GENERATION_FAILED' } } });
    expect(await requestRetroSynthesis(args)).toBeNull();
    waitForBackgroundJobMock.mockResolvedValue(null);
    expect(await requestRetroSynthesis(args)).toBeNull();
    expect(await requestRetroSynthesis({ ...args, orgId: undefined })).toBeNull();
    respond(null, 409);
    expect(await requestRetroSynthesis(args)).toBeNull();
  });

  it('바로 온 200 본문(예전 모양)도 그대로 받는다 — 작업을 기다리지 않는다', async () => {
    respond(SESSION);
    expect(await requestRetroSynthesis(args)).toEqual({ synthesis: SESSION.synthesis, next_hypotheses: SESSION.next_hypotheses });
    expect(waitForBackgroundJobMock).not.toHaveBeenCalled();
  });
});
