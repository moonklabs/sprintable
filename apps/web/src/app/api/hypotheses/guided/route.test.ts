import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #2542(BE PR#2942) — guided 3부 폼 전용 생성 라우트. 형제(/api/hypotheses POST) 테스트가
// 없어 새 패턴 선례 없이 stories/route.test.ts의 vi.hoisted+vi.mock 관례를 그대로 재사용한다.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(), createHypothesisRepository: vi.fn(), createGuided: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createHypothesisRepository: h.createHypothesisRepository }));
vi.mock('@/services/hypothesis', async (importActual) => ({
  ...(await importActual<typeof import('@/services/hypothesis')>()),
  HypothesisService: class { createGuided = h.createGuided; },
}));

import { POST } from './route';

const human = () => ({ id: 'm1', type: 'human', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

function req(body: unknown) {
  return new Request('http://localhost/api/hypotheses/guided', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = { project_id: 'p1', statement: '결제 완료율을 개선하면 이탈이 준다', metric: 'checkout_rate', target: 60, direction: 'up' };

describe('/api/hypotheses/guided POST', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(human());
    h.createHypothesisRepository.mockResolvedValue({});
  });

  it('401 when unauthenticated', async () => {
    h.getAuthContext.mockResolvedValue(null);
    const res = await POST(req(validBody));
    expect(res.status).toBe(401);
    expect(h.createGuided).not.toHaveBeenCalled();
  });

  it('400 when a required field is missing (statement)', async () => {
    const { statement: _statement, ...rest } = validBody;
    const res = await POST(req(rest));
    expect(res.status).toBe(400);
    expect(h.createGuided).not.toHaveBeenCalled();
  });

  it('400 when direction is not up/down (zod enum guard before hitting BE)', async () => {
    const res = await POST(req({ ...validBody, direction: 'sideways' }));
    expect(res.status).toBe(400);
    expect(h.createGuided).not.toHaveBeenCalled();
  });

  it('valid body → forwards exact 4 fields to service, wraps response in {data}', async () => {
    h.createGuided.mockResolvedValue({ id: 'h1', status: 'measuring', statement: validBody.statement });
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: 'h1', status: 'measuring', statement: validBody.statement });
    expect(h.createGuided).toHaveBeenCalledWith(validBody);
  });
});
