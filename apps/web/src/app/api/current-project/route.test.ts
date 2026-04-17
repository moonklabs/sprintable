import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieSet, createSupabaseServerClient } = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: cookieSet })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient,
}));

import { POST } from './route';
import { CURRENT_PROJECT_COOKIE } from '@/lib/auth-helpers';

function createMembershipSupabaseStub(membership: { project_id: string; projects: { name: string } | null } | null) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn().mockResolvedValue({ data: membership, error: null }),
  };

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
    from: vi.fn(() => query),
  };
}

describe('POST /api/current-project', () => {
  beforeEach(() => {
    cookieSet.mockReset();
    createSupabaseServerClient.mockReset();
  });

  it('persists current project cookie when the requested project belongs to the user', async () => {
    createSupabaseServerClient.mockResolvedValue(createMembershipSupabaseStub({
      project_id: 'project-1',
      projects: { name: 'Alpha' },
    }));

    const response = await POST(new Request('http://localhost/api/current-project', {
      method: 'POST',
      body: JSON.stringify({ project_id: 'project-1' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.project_name).toBe('Alpha');
    expect(cookieSet).toHaveBeenCalledWith(CURRENT_PROJECT_COOKIE, 'project-1', expect.objectContaining({ path: '/' }));
  });

  it('returns validation errors for malformed payloads', async () => {
    createSupabaseServerClient.mockResolvedValue(createMembershipSupabaseStub(null));

    const response = await POST(new Request('http://localhost/api/current-project', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('rejects switching to a project without membership', async () => {
    createSupabaseServerClient.mockResolvedValue(createMembershipSupabaseStub(null));

    const response = await POST(new Request('http://localhost/api/current-project', {
      method: 'POST',
      body: JSON.stringify({ project_id: 'project-2' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
