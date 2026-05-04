import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, createAdminClient, getAuthContext, parseBody } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  getAuthContext: vi.fn(),
  parseBody: vi.fn(),
}));
const updateDoc = vi.fn();
const getDocTimestamp = vi.fn();

vi.mock('@sprintable/shared', () => ({
  parseBody,
  updateDocSchema: {},
  VALID_STORY_TRANSITIONS: {
    backlog: ['ready-for-dev'],
    'ready-for-dev': ['in-progress', 'backlog'],
    'in-progress': ['in-review', 'ready-for-dev'],
    'in-review': ['done', 'in-progress'],
    done: ['in-review'],
  },
}));
vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({
  createDocRepository: vi.fn().mockResolvedValue({
    getById: vi.fn().mockResolvedValue({ id: 'doc-1', org_id: 'org-1', doc_type: 'page' }),
    update: vi.fn().mockResolvedValue({ id: 'doc-1', updated_at: '2026-04-09T15:21:00.000Z' }),
    delete: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('@/services/docs', () => {
  class DocsServiceMock {
    updateDoc = updateDoc;
    getDocTimestamp = getDocTimestamp;
  }

  return { DocsService: DocsServiceMock };
});

import { GET, PATCH } from './route';

const mockAuth = {
  id: 'team-member-1',
  org_id: 'org-1',
  project_id: 'project-1',
  project_name: 'Test',
  type: 'human' as const,
  rateLimitExceeded: false,
};

describe('/api/docs/[id] route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createDbServerClient.mockResolvedValue({});
    createAdminClient.mockReturnValue({});
    getAuthContext.mockResolvedValue(mockAuth);
    parseBody.mockResolvedValue({
      success: true,
      data: {
        content: 'updated content',
        content_format: 'markdown',
        icon: '📘',
        tags: ['docs', 'mobile'],
        expected_updated_at: '2026-04-09T15:20:00.000Z',
        force_overwrite: false,
      },
    });
    updateDoc.mockResolvedValue({
      id: 'doc-1',
      content: 'updated content',
      content_format: 'markdown',
      updated_at: '2026-04-09T15:21:00.000Z',
    });
    getDocTimestamp.mockResolvedValue({ updated_at: '2026-04-09T15:21:00.000Z' });
  });

  it('passes optimistic concurrency fields through PATCH', async () => {
    const response = await PATCH(new Request('http://localhost/api/docs/doc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'updated content' }),
    }), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(200);
    expect(updateDoc).toHaveBeenCalledWith('doc-1', {
      content: 'updated content',
      content_format: 'markdown',
      icon: '📘',
      tags: ['docs', 'mobile'],
      expected_updated_at: '2026-04-09T15:20:00.000Z',
      force_overwrite: false,
      created_by: 'team-member-1',
    });
  });

  it('returns 409 when the docs service raises a conflict', async () => {
    const error = Object.assign(new Error('Document was modified by another user'), { code: 'CONFLICT' });
    updateDoc.mockRejectedValue(error);

    const response = await PATCH(new Request('http://localhost/api/docs/doc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'updated content' }),
    }), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    const json = await response.json();
    expect(response.status).toBe(409);
    expect(json.error).toEqual({ code: 'CONFLICT', message: 'Document was modified by another user' });
  });

  it('exposes a lightweight timestamp GET for remote-change polling', async () => {
    const response = await GET(new Request('http://localhost/api/docs/doc-1'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(getDocTimestamp).toHaveBeenCalledWith('doc-1');
    expect(json.data).toEqual({ updated_at: '2026-04-09T15:21:00.000Z' });
  });

  it('returns 401 when not authenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    const response = await PATCH(new Request('http://localhost/api/docs/doc-1', {
      method: 'PATCH',
      body: JSON.stringify({}),
    }), { params: Promise.resolve({ id: 'doc-1' }) });
    expect(response.status).toBe(401);
  });

  it('returns 429 when rate limit exceeded', async () => {
    getAuthContext.mockResolvedValue({ ...mockAuth, rateLimitExceeded: true, rateLimitRemaining: 0, rateLimitResetAt: 9999 });
    const response = await GET(new Request('http://localhost/api/docs/doc-1'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });
    expect(response.status).toBe(429);
  });
});
