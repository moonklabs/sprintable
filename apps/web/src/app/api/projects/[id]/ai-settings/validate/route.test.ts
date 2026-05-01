import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, getMyTeamMember, requireOrgAdmin } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  createDbServerClient,
}));

vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return {
    ...actual,
    getMyTeamMember,
  };
});

vi.mock('@/lib/admin-check', () => ({
  requireOrgAdmin,
}));

import { POST } from './route';

function createDbStub() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
  };
}

describe('POST /api/projects/[id]/ai-settings/validate', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    getMyTeamMember.mockResolvedValue({ id: 'team-member-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdmin.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns 401 when unauthenticated', async () => {
    const db = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    };
    createDbServerClient.mockResolvedValue(db);

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ai-settings/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', api_key: 'sk-test' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 when api_key is missing', async () => {
    createDbServerClient.mockResolvedValue(createDbStub());

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ai-settings/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(400);
  });

  it('returns valid=true when provider responds with 200', async () => {
    createDbServerClient.mockResolvedValue(createDbStub());
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ai-settings/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', api_key: 'sk-valid-key' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.valid).toBe(true);
  });

  it('returns valid=false when provider responds with 401', async () => {
    createDbServerClient.mockResolvedValue(createDbStub());
    const fetchMock = vi.fn().mockResolvedValue({ status: 401 });
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ai-settings/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', api_key: 'sk-invalid-key' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.valid).toBe(false);
  });

  it('sends POST for anthropic provider validation', async () => {
    createDbServerClient.mockResolvedValue(createDbStub());
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await POST(
      new Request('http://localhost/api/projects/project-1/ai-settings/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', api_key: 'sk-ant-test' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('requires base_url for openai-compatible validation', async () => {
    createDbServerClient.mockResolvedValue(createDbStub());

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ai-settings/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', api_key: 'sk-test' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toContain('base_url is required for openai-compatible provider');
  });

  it('validates openai-compatible keys against the provided base_url', async () => {
    createDbServerClient.mockResolvedValue(createDbStub());
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ai-settings/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai-compatible',
          api_key: 'sk-test',
          base_url: 'https://llm.example.com/v1/',
        }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://llm.example.com/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses x-goog-api-key header for google validation instead of query params', async () => {
    createDbServerClient.mockResolvedValue(createDbStub());
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ai-settings/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', api_key: 'google-secret-key' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-goog-api-key': 'google-secret-key' }),
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('google-secret-key');
  });

  it('returns 400 for invalid provider value', async () => {
    createDbServerClient.mockResolvedValue(createDbStub());

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ai-settings/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'invalid-provider', api_key: 'sk-test' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(400);
  });
});
