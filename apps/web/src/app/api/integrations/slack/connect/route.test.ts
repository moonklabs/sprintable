// @vitest-environment node
//
// story #2500 — `err.message.includes('403')`가 실제 403 사유 메시지("Admin access
// required")엔 "403"이라는 부분문자열이 없어 항상 false였다(그라운딩 확認) — 진짜
// 403(admin 권한 필요)도 조용히 400으로 격하되던 버그. ForbiddenError instanceof로 교정.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@sprintable/core-storage';

const { getServerSessionMock, fastapiCallMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn(),
  fastapiCallMock: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));
vi.mock('@/lib/fastapi-proxy', () => ({ fastapiCall: fastapiCallMock }));

import { GET } from './route';

afterEach(() => {
  vi.resetAllMocks();
});

describe('GET /api/integrations/slack/connect (story #2500)', () => {
  it('ForbiddenError(admin 권한 필요) — 403으로 정확히 응답한다(핵심 회귀가드)', async () => {
    getServerSessionMock.mockResolvedValue({ access_token: 'tok' });
    fastapiCallMock.mockRejectedValue(new ForbiddenError('Admin access required'));

    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('그 외 에러(예: NotFoundError)는 400으로 응답한다(회귀 없음)', async () => {
    getServerSessionMock.mockResolvedValue({ access_token: 'tok' });
    fastapiCallMock.mockRejectedValue(new NotFoundError('not found'));

    const res = await GET();
    expect(res.status).toBe(400);
  });
});
