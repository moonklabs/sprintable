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

function createSupabaseStub(projectId: string | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
    rpc: vi.fn().mockResolvedValue({
      data: { ok: true, project_id: projectId },
      error: null,
    }),
  };
}

describe('POST /api/invitations/accept', () => {
  beforeEach(() => {
    cookieSet.mockReset();
    createSupabaseServerClient.mockReset();
  });

  it('sets current project cookie when accept_invitation returns a project_id', async () => {
    createSupabaseServerClient.mockResolvedValue(createSupabaseStub('project-1'));

    const response = await POST(new Request('http://localhost/api/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'invite-token' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.project_id).toBe('project-1');
    expect(cookieSet).toHaveBeenCalledWith(CURRENT_PROJECT_COOKIE, 'project-1', expect.objectContaining({ path: '/' }));
  });

  it('returns validation errors for malformed payloads', async () => {
    createSupabaseServerClient.mockResolvedValue(createSupabaseStub(null));

    const response = await POST(new Request('http://localhost/api/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: '' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('does not set current project cookie when accept_invitation returns null project_id', async () => {
    createSupabaseServerClient.mockResolvedValue(createSupabaseStub(null));

    const response = await POST(new Request('http://localhost/api/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'invite-token' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.project_id).toBeNull();
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
