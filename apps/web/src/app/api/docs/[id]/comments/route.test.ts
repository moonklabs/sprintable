import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, createAdminClient, getAuthContext, notifyDocCommentMentions, addComment } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  getAuthContext: vi.fn(),
  notifyDocCommentMentions: vi.fn(),
  addComment: vi.fn(),
}));

vi.mock('@sprintable/shared', () => ({
  parseBody: vi.fn(async (_request: Request, _schema: unknown) => ({
    success: true,
    data: { content: '@파울로 오르테가 검토 부탁드리는.' },
  })),
  createDocCommentSchema: {},
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
vi.mock('@/services/doc-comment-notifications', () => ({ notifyDocCommentMentions }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/services/docs', () => {
  class DocsServiceMock {
    addComment = addComment;
  }

  return { DocsService: DocsServiceMock };
});

import { POST } from './route';

const mockAuth = {
  id: 'team-member-1',
  org_id: 'org-1',
  project_id: 'project-1',
  project_name: 'Test',
  type: 'human' as const,
  rateLimitExceeded: false,
};

describe('POST /api/docs/[id]/comments', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    createAdminClient.mockReset();
    getAuthContext.mockReset();
    notifyDocCommentMentions.mockReset();
    addComment.mockReset();

    createDbServerClient.mockResolvedValue({});
    createAdminClient.mockReturnValue({ tag: 'admin' });
    getAuthContext.mockResolvedValue(mockAuth);
    addComment.mockResolvedValue({
      id: 'comment-1',
      content: '@파울로 오르테가 검토 부탁드리는.',
    });
  });

  it('creates mention notifications after a comment is saved', async () => {
    const response = await POST(new Request('http://localhost/api/docs/doc-1/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '@파울로 오르테가 검토 부탁드리는.' }),
    }), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(201);
    expect(addComment).toHaveBeenCalledWith({
      doc_id: 'doc-1',
      content: '@파울로 오르테가 검토 부탁드리는.',
      created_by: 'team-member-1',
    });
    expect(notifyDocCommentMentions).toHaveBeenCalledWith(
      expect.objectContaining({
        docId: 'doc-1',
        commentId: 'comment-1',
        content: '@파울로 오르테가 검토 부탁드리는.',
        authorId: 'team-member-1',
      }),
    );
  });

  it('still returns success when mention notification creation fails', async () => {
    notifyDocCommentMentions.mockRejectedValue(new Error('notification failed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(new Request('http://localhost/api/docs/doc-1/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '@파울로 오르테가 검토 부탁드리는.' }),
    }), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(201);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[Docs] failed to create comment mention notifications',
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });

  it('returns 401 when not authenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    const response = await POST(new Request('http://localhost/api/docs/doc-1/comments', {
      method: 'POST',
      body: JSON.stringify({ content: 'test' }),
    }), { params: Promise.resolve({ id: 'doc-1' }) });
    expect(response.status).toBe(401);
  });

  it('returns 429 when rate limit exceeded', async () => {
    getAuthContext.mockResolvedValue({ ...mockAuth, rateLimitExceeded: true, rateLimitRemaining: 0, rateLimitResetAt: 9999 });
    const response = await POST(new Request('http://localhost/api/docs/doc-1/comments', {
      method: 'POST',
      body: JSON.stringify({ content: 'test' }),
    }), { params: Promise.resolve({ id: 'doc-1' }) });
    expect(response.status).toBe(429);
  });
});
