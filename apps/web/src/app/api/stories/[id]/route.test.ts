import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
}));

const { getAuthContext } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
}));

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));

const getByIdWithDetailsMock = vi.fn();

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/services/story', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/story')>();
  return {
    ...actual,
    StoryService: class { getByIdWithDetails = getByIdWithDetailsMock; },
  };
});

import { GET } from './route';

describe('GET /api/stories/[id]', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getAuthContext.mockReset();
    createAdminClient.mockReset();
    getByIdWithDetailsMock.mockReset();
    createDbServerClient.mockResolvedValue({});
    createAdminClient.mockReturnValue({});
  });

  it('returns 401 when no auth context', async () => {
    getAuthContext.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost/api/stories/story-1'),
      { params: Promise.resolve({ id: 'story-1' }) }
    );

    expect(response.status).toBe(401);
  });

  it('returns 429 when rate limit exceeded', async () => {
    getAuthContext.mockResolvedValue({
      id: 'agent-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'agent',
      rateLimitExceeded: true,
      rateLimitRemaining: 0,
      rateLimitResetAt: Date.now() + 60000,
    });

    const response = await GET(
      new Request('http://localhost/api/stories/story-1'),
      { params: Promise.resolve({ id: 'story-1' }) }
    );

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe('Rate limit exceeded');
  });

  it('uses admin client for agent auth', async () => {
    getAuthContext.mockResolvedValue({
      id: 'agent-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'agent',
      rateLimitExceeded: false,
    });

    const mockAdminClient = { admin: true };
    createAdminClient.mockReturnValue(mockAdminClient);
    getByIdWithDetailsMock.mockResolvedValue({ id: 'story-1', title: 'Test Story' });

    await GET(
      new Request('http://localhost/api/stories/story-1'),
      { params: Promise.resolve({ id: 'story-1' }) }
    );

    expect(createAdminClient).toHaveBeenCalled();
    expect(getByIdWithDetailsMock).toHaveBeenCalled();
  });

  it('uses server client for human auth', async () => {
    getAuthContext.mockResolvedValue({
      id: 'member-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'human',
    });

    const mockServerClient = { server: true };
    createDbServerClient.mockResolvedValue(mockServerClient);
    getByIdWithDetailsMock.mockResolvedValue({ id: 'story-1', title: 'Test Story' });

    await GET(
      new Request('http://localhost/api/stories/story-1'),
      { params: Promise.resolve({ id: 'story-1' }) }
    );

    expect(createAdminClient).not.toHaveBeenCalled();
    expect(getByIdWithDetailsMock).toHaveBeenCalled();
  });

  it('returns story data on success', async () => {
    getAuthContext.mockResolvedValue({
      id: 'member-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'human',
    });

    const mockStory = { id: 'story-1', title: 'Test Story', status: 'ready-for-dev', project_id: 'project-1' };
    getByIdWithDetailsMock.mockResolvedValue(mockStory);

    const response = await GET(
      new Request('http://localhost/api/stories/story-1'),
      { params: Promise.resolve({ id: 'story-1' }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(mockStory);
  });

  it('returns 403 when agent tries to access cross-project story', async () => {
    getAuthContext.mockResolvedValue({
      id: 'agent-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'agent',
      rateLimitExceeded: false,
    });

    const mockAdminClient = { admin: true };
    createAdminClient.mockReturnValue(mockAdminClient);
    // Story belongs to different project
    getByIdWithDetailsMock.mockResolvedValue({
      id: 'story-2',
      title: 'Other Project Story',
      project_id: 'project-2',
    });

    const response = await GET(
      new Request('http://localhost/api/stories/story-2'),
      { params: Promise.resolve({ id: 'story-2' }) }
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.message).toContain('cross-project');
  });

  it('allows agent to access same-project story', async () => {
    getAuthContext.mockResolvedValue({
      id: 'agent-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'agent',
      rateLimitExceeded: false,
    });

    const mockAdminClient = { admin: true };
    createAdminClient.mockReturnValue(mockAdminClient);
    getByIdWithDetailsMock.mockResolvedValue({
      id: 'story-1',
      title: 'Same Project Story',
      project_id: 'project-1',
    });

    const response = await GET(
      new Request('http://localhost/api/stories/story-1'),
      { params: Promise.resolve({ id: 'story-1' }) }
    );

    expect(response.status).toBe(200);
  });
});
