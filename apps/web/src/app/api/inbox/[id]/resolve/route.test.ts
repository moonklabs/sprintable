import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createDbServerClient,
  createAdminClient,
  getAuthContext,
  createInboxItemRepository,
  isOssMode,
} = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  getAuthContext: vi.fn(),
  createInboxItemRepository: vi.fn(),
  isOssMode: vi.fn(() => false),
}));

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getAuthContext };
});
vi.mock('@/lib/storage/factory', () => ({ createInboxItemRepository, isOssMode }));

import { POST } from './route';
import { NotFoundError } from '@sprintable/core-storage';

const ME = {
  id: 'tm-1',
  org_id: 'org-1',
  project_id: 'proj-1',
  project_name: 'Proj',
  type: 'human' as const,
  rateLimitExceeded: false,
  rateLimitRemaining: 299,
  rateLimitResetAt: 0,
};

// Use a valid RFC 4122 v4 UUID (variant nibble must be 8/9/a/b).
const VALID_OPTION_ID = '123e4567-e89b-42d3-a456-426614174000';

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/inbox/i1/resolve', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const PARAMS = { params: Promise.resolve({ id: 'i1' }) };

describe('POST /api/inbox/[id]/resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isOssMode.mockReturnValue(false);
    createDbServerClient.mockResolvedValue({});
    getAuthContext.mockResolvedValue(ME);
  });

  it('401 without auth', async () => {
    getAuthContext.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ choice: VALID_OPTION_ID }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('200 success calls repo.resolve with assignee = me.id', async () => {
    const item = { id: 'i1', state: 'resolved', resolved_option_id: VALID_OPTION_ID };
    const repo = { resolve: vi.fn().mockResolvedValue(item) };
    createInboxItemRepository.mockResolvedValue(repo);

    const res = await POST(makeRequest({ choice: VALID_OPTION_ID, note: 'ok' }), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.state).toBe('resolved');
    expect(repo.resolve).toHaveBeenCalledWith('i1', 'org-1', {
      resolved_by: 'tm-1',
      resolved_option_id: VALID_OPTION_ID,
      resolved_note: 'ok',
    });
  });

  it('400 on missing choice', async () => {
    createInboxItemRepository.mockResolvedValue({ resolve: vi.fn() });

    const res = await POST(makeRequest({ note: 'ok' }), PARAMS);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('400 on non-uuid choice', async () => {
    createInboxItemRepository.mockResolvedValue({ resolve: vi.fn() });

    const res = await POST(makeRequest({ choice: 'not-uuid' }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('404 when repo throws NotFoundError', async () => {
    const repo = {
      resolve: vi.fn().mockRejectedValue(new NotFoundError('Inbox item not found: i1')),
    };
    createInboxItemRepository.mockResolvedValue(repo);

    const res = await POST(makeRequest({ choice: VALID_OPTION_ID }), PARAMS);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('409 when item already resolved (double-resolve)', async () => {
    const repo = {
      resolve: vi.fn().mockRejectedValue(new Error('Inbox item already resolved')),
    };
    createInboxItemRepository.mockResolvedValue(repo);

    const res = await POST(makeRequest({ choice: VALID_OPTION_ID }), PARAMS);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('400 when option_id not in options', async () => {
    const repo = {
      resolve: vi.fn().mockRejectedValue(new Error('Option id xxx not found in inbox item options')),
    };
    createInboxItemRepository.mockResolvedValue(repo);

    const res = await POST(makeRequest({ choice: VALID_OPTION_ID }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('OSS mode passes undefined dbClient', async () => {
    isOssMode.mockReturnValue(true);
    const repo = { resolve: vi.fn().mockResolvedValue({ id: 'i1', state: 'resolved' }) };
    createInboxItemRepository.mockResolvedValue(repo);

    await POST(makeRequest({ choice: VALID_OPTION_ID }), PARAMS);
    expect(createInboxItemRepository).toHaveBeenCalledWith(undefined);
  });
});
