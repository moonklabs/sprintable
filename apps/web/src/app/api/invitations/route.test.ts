import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient,
}));

import { POST } from './route';

function createSupabaseStub() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
  };
}

describe('POST /api/invitations', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
  });

  it('returns validation errors for malformed payloads', async () => {
    createSupabaseServerClient.mockResolvedValue(createSupabaseStub());

    const response = await POST(new Request('http://localhost/api/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
