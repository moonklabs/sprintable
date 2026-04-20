import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockList, mockUpdate } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@/lib/storage/factory', () => ({
  createStoryRepository: vi.fn().mockResolvedValue({ list: mockList, update: mockUpdate }),
}));

import { POST } from './route';

const SECRET = 'webhook-secret-xyz';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
}

function makeRequest(body: object, overrides: Record<string, string | null> = {}): Request {
  const raw = JSON.stringify(body);
  return {
    text: async () => raw,
    headers: {
      get: (name: string) => {
        const map: Record<string, string | null> = {
          'x-github-event': 'pull_request',
          'x-hub-signature-256': sign(raw),
          ...overrides,
        };
        return map[name] ?? null;
      },
    },
  } as unknown as Request;
}

const mergedPrPayload = {
  action: 'closed',
  pull_request: { merged: true, title: 'feat: auth [SPR-1]', body: null, number: 42, html_url: '' },
  repository: { full_name: 'org/repo' },
};

beforeEach(() => {
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
  mockList.mockReset();
  mockUpdate.mockReset();
});

describe('POST /api/webhooks/github', () => {
  it('returns 400 when secret is not configured', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
    const res = await POST(makeRequest(mergedPrPayload));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid signature', async () => {
    const res = await POST(makeRequest(mergedPrPayload, { 'x-hub-signature-256': 'sha256=badbeef' }));
    expect(res.status).toBe(400);
  });

  it('returns 200 for non-PR events', async () => {
    const res = await POST(makeRequest({}, { 'x-github-event': 'push' }));
    expect(res.status).toBe(200);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns 200 for closed but not merged PR', async () => {
    const payload = { ...mergedPrPayload, pull_request: { ...mergedPrPayload.pull_request, merged: false } };
    const res = await POST(makeRequest(payload));
    expect(res.status).toBe(200);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('closes matching story on PR merge', async () => {
    mockList.mockResolvedValue([{ id: 'story-1', title: 'SPR-1: Auth', status: 'in_progress' }]);

    const res = await POST(makeRequest(mergedPrPayload));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('story-1', { status: 'done' });
  });

  it('skips story already in done status', async () => {
    mockList.mockResolvedValue([{ id: 'story-1', title: 'SPR-1: Auth', status: 'done' }]);

    const res = await POST(makeRequest(mergedPrPayload));
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 200 even if story repo throws', async () => {
    mockList.mockRejectedValue(new Error('db error'));

    const res = await POST(makeRequest(mergedPrPayload));
    expect(res.status).toBe(200);
  });

  it('returns 200 when no ticket ID in PR title', async () => {
    const payload = { ...mergedPrPayload, pull_request: { ...mergedPrPayload.pull_request, title: 'refactor: cleanup' } };
    const res = await POST(makeRequest(payload));
    expect(res.status).toBe(200);
    expect(mockList).not.toHaveBeenCalled();
  });
});
