import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClient, scan } = vi.hoisted(() => {
  process.env.CRON_SECRET = 'cron-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  return {
    createClient: vi.fn(),
    scan: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient }));
vi.mock('@/services/inbox-outbox.service', () => ({
  InboxOutboxService: class InboxOutboxService {
    scan = scan;
  },
}));

import { GET } from './route';

describe('GET /api/cron/inbox-outbox', () => {
  beforeEach(() => {
    createClient.mockReset();
    scan.mockReset();
  });

  it('rejects unauthorized cron calls', async () => {
    const response = await GET(new Request('http://localhost/api/cron/inbox-outbox'));
    expect(response.status).toBe(401);
  });

  it('returns scanner results for authorized cron calls', async () => {
    createClient.mockReturnValue({});
    scan.mockResolvedValue({
      scanned: 3,
      delivered: 2,
      retried: 1,
      dead: 0,
      skipped: 0,
    });

    const response = await GET(
      new Request('http://localhost/api/cron/inbox-outbox', {
        headers: { authorization: 'Bearer cron-secret' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { scanned: 3, delivered: 2, retried: 1, dead: 0, skipped: 0 },
    });
  });

  it('returns 500 when service throws', async () => {
    createClient.mockReturnValue({});
    scan.mockRejectedValue(new Error('rpc_failed'));

    const response = await GET(
      new Request('http://localhost/api/cron/inbox-outbox', {
        headers: { authorization: 'Bearer cron-secret' },
      }),
    );

    expect(response.status).toBe(500);
  });
});
