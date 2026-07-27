import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #2194 — 뱃지 카운트가 list(limit:200).length 자작 계산이 아니라 repo.countUnread()
// (BE 진짜 unbounded SQL COUNT)를 쓰는지 검증한다.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(), createNotificationRepository: vi.fn(),
  countUnread: vi.fn(), list: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createNotificationRepository: h.createNotificationRepository }));

import { GET } from './route';

const agent = () => ({ id: 'mem-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

describe('/api/notifications/count (story #2194)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createNotificationRepository.mockResolvedValue({ countUnread: h.countUnread, list: h.list });
  });

  it('401 when unauthenticated', async () => {
    h.getAuthContext.mockResolvedValue(null);
    expect((await GET(new Request('http://localhost/api/notifications/count'))).status).toBe(401);
  });

  it('repo.countUnread()이 반환하는 값을 그대로 뱃지 수로 쓴다(list는 안 부른다)', async () => {
    h.countUnread.mockResolvedValue(250);
    const res = await GET(new Request('http://localhost/api/notifications/count'));
    const body = await res.json();

    expect(body.data.inboxUnreadCount).toBe(250);
    expect(h.countUnread).toHaveBeenCalledWith('mem-1');
    expect(h.list).not.toHaveBeenCalled();
  });

  it('음성대조 — 200 이하 값도 그대로 통과한다(캡 없음)', async () => {
    h.countUnread.mockResolvedValue(7);
    const res = await GET(new Request('http://localhost/api/notifications/count'));
    const body = await res.json();

    expect(body.data.inboxUnreadCount).toBe(7);
  });
});
