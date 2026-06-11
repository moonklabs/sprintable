import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b9): 직접 repo 핸들러(NotificationRepository) — auth게이트 → repo.list/markRead/markAllRead.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(), createNotificationRepository: vi.fn(),
  list: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn(),
  attachHrefs: vi.fn(), parseBody: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createNotificationRepository: h.createNotificationRepository }));
vi.mock('@/services/notification-navigation', () => ({ attachNotificationHrefs: h.attachHrefs }));
vi.mock('@sprintable/shared', async (importActual) => ({
  ...(await importActual<typeof import('@sprintable/shared')>()),
  parseBody: h.parseBody,
}));

import { GET, PATCH } from './route';

const agent = () => ({ id: 'mem-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

describe('/api/notifications (직접 repo)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createNotificationRepository.mockResolvedValue({ list: h.list, markRead: h.markRead, markAllRead: h.markAllRead });
    h.attachHrefs.mockImplementation(async (_c: unknown, items: unknown[]) => items);
  });

  it('GET: 401 when unauthenticated', async () => {
    h.getAuthContext.mockResolvedValue(null);
    expect((await GET(new Request('http://localhost/api/notifications'))).status).toBe(401);
  });
  it('GET: lists via repo + attachHrefs + unreadCount meta', async () => {
    h.list.mockResolvedValue([{ id: 'n1', is_read: false, type: 'x' }, { id: 'n2', is_read: true, type: 'x' }]);
    const res = await GET(new Request('http://localhost/api/notifications'));
    expect(res.status).toBe(200);
    expect(h.list).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'mem-1' }));
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.meta.unreadCount).toBe(1);
  });

  it('PATCH: invalid body → parseBody 400', async () => {
    h.parseBody.mockResolvedValue({ success: false, response: new Response('bad', { status: 400 }) });
    expect((await PATCH(new Request('http://localhost/api/notifications', { method: 'PATCH', body: '{}' }))).status).toBe(400);
  });
  it('PATCH: markAllRead → {ok:true}', async () => {
    h.parseBody.mockResolvedValue({ success: true, data: { markAllRead: true } });
    h.markAllRead.mockResolvedValue(undefined);
    const res = await PATCH(new Request('http://localhost/api/notifications', { method: 'PATCH', body: '{}' }));
    expect(res.status).toBe(200);
    expect(h.markAllRead).toHaveBeenCalledWith('mem-1');
  });
  it('PATCH: markRead(id) → {ok:true}', async () => {
    h.parseBody.mockResolvedValue({ success: true, data: { id: 'n1' } });
    h.markRead.mockResolvedValue(undefined);
    const res = await PATCH(new Request('http://localhost/api/notifications', { method: 'PATCH', body: '{}' }));
    expect(res.status).toBe(200);
    expect(h.markRead).toHaveBeenCalledWith('n1', 'mem-1');
  });
  it('PATCH: neither id nor markAllRead → 400', async () => {
    h.parseBody.mockResolvedValue({ success: true, data: {} });
    expect((await PATCH(new Request('http://localhost/api/notifications', { method: 'PATCH', body: '{}' }))).status).toBe(400);
  });
});
