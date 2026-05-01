import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, getAuthContext, createAdminClient, attachNotificationHrefs } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createAdminClient: vi.fn(),
  attachNotificationHrefs: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/services/notification-navigation', () => ({ attachNotificationHrefs }));

import { GET, PATCH } from './route';

function createNotificationsQueryStub(rows: Record<string, unknown>[]) {
  const query: {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    then: Promise<{ data: Record<string, unknown>[]; error: null }>['then'];
  } = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null })),
  };

  return query;
}

function createCountQueryStub(count: number) {
  const query: {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    then: Promise<{ count: number; error: null }>['then'];
  } = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    then: Promise.resolve({ count, error: null }).then.bind(Promise.resolve({ count, error: null })),
  };

  return query;
}

describe('GET /api/notifications', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getAuthContext.mockReset();
    createAdminClient.mockReset();
    attachNotificationHrefs.mockReset();
    getAuthContext.mockResolvedValue({ id: 'team-member-1', type: 'human', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
  });

  it('attaches deep-link hrefs to notification payloads', async () => {
    const rows = [
      { id: 'notification-1', reference_type: 'memo', reference_id: 'memo-1', is_read: false, type: 'memo', title: '메모', body: null, created_at: '2026-04-08T18:00:00Z' },
    ];
    const notificationsQuery = createNotificationsQueryStub(rows);
    const countQuery = createCountQueryStub(1);
    const db = {
      from: vi.fn((table: string) => {
        if (table !== 'notifications') throw new Error(`unexpected table: ${table}`);
        return db.from.mock.calls.length === 1 ? notificationsQuery : countQuery;
      }),
    };

    createDbServerClient.mockResolvedValue(db);
    attachNotificationHrefs.mockResolvedValue([
      { ...rows[0], href: '/memos?id=memo-1' },
    ]);

    const response = await GET(new Request('http://localhost/api/notifications'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(attachNotificationHrefs).toHaveBeenCalledWith(db, rows);
    expect(body.data).toEqual([
      expect.objectContaining({ id: 'notification-1', href: '/memos?id=memo-1' }),
    ]);
    expect(body.meta.unreadCount).toBe(1);
  });
});

describe('PATCH /api/notifications', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getAuthContext.mockReset();
    createAdminClient.mockReset();
    attachNotificationHrefs.mockReset();
    getAuthContext.mockResolvedValue({ id: 'team-member-1', type: 'human', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
  });

  it('returns validation errors for malformed payloads', async () => {
    createDbServerClient.mockResolvedValue({});

    const response = await PATCH(new Request('http://localhost/api/notifications', {
      method: 'PATCH',
      body: JSON.stringify({ type: 'memo' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
