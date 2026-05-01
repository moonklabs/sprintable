import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClient, scan } = vi.hoisted(() => {
  process.env.CRON_SECRET = 'cron-secret';
  process.env.DATABASE_URL = 'https://example.db.co';
  process.env.DATABASE_SERVICE_KEY = 'service-role-key';

  return {
    createClient: vi.fn(),
    scan: vi.fn(),
  };
});

vi.mock('@/services/agent-hitl-timeout', () => ({
  AgentHitlTimeoutService: class AgentHitlTimeoutService {
    scan = scan;
  },
}));

import { GET } from './route';

describe('GET /api/cron/hitl-timeouts', () => {
  beforeEach(() => {
    createClient.mockReset();
    scan.mockReset();
  });

  it('rejects unauthorized cron calls', async () => {
    const response = await GET(new Request('http://localhost/api/cron/hitl-timeouts'));
    expect(response.status).toBe(401);
  });

  it('returns scanner results for authorized cron calls', async () => {
    createClient.mockReturnValue({});
    scan.mockResolvedValue({ reminders_sent: 1, timed_out: 2 });

    const response = await GET(new Request('http://localhost/api/cron/hitl-timeouts', {
      headers: { authorization: 'Bearer cron-secret' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { reminders_sent: 1, timed_out: 2 },
    });
  });
});
