import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolveInternalDogfoodActor,
  encodeInternalDogfoodSession,
} = vi.hoisted(() => ({
  resolveInternalDogfoodActor: vi.fn(),
  encodeInternalDogfoodSession: vi.fn(() => 'signed-session-token'),
}));

vi.mock('@/lib/internal-dogfood', async () => {
  const actual = await vi.importActual<typeof import('@/lib/internal-dogfood')>('@/lib/internal-dogfood');
  return {
    ...actual,
    encodeInternalDogfoodSession,
    resolveInternalDogfoodActor,
  };
});

import { POST } from './route';

describe('POST /api/internal-dogfood/session', () => {
  const originalEnabled = process.env.INTERNAL_DOGFOOD_ACCESS_ENABLED;
  const originalSecret = process.env.INTERNAL_DOGFOOD_ACCESS_SECRET;

  beforeEach(() => {
    process.env.INTERNAL_DOGFOOD_ACCESS_ENABLED = 'true';
    process.env.INTERNAL_DOGFOOD_ACCESS_SECRET = 'dogfood-secret';
    resolveInternalDogfoodActor.mockReset();
    encodeInternalDogfoodSession.mockClear();
  });

  afterAll(() => {
    process.env.INTERNAL_DOGFOOD_ACCESS_ENABLED = originalEnabled;
    process.env.INTERNAL_DOGFOOD_ACCESS_SECRET = originalSecret;
  });

  it('sets the signed cookie for an allowed actor', async () => {
    resolveInternalDogfoodActor.mockReturnValue({
      id: 'tm-1',
      org_id: 'org-1',
      project_id: 'project-1',
      name: 'Didi',
      project_name: 'Sprintable',
    });

    const formData = new FormData();
    formData.set('secret', 'dogfood-secret');
    formData.set('team_member_id', 'tm-1');

    const response = await POST(new Request('http://localhost/api/internal-dogfood/session', {
      method: 'POST',
      body: formData,
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/internal-dogfood?actor=tm-1');
    expect(response.headers.get('set-cookie')).toContain('sprintable_internal_dogfood=signed-session-token');
    expect(encodeInternalDogfoodSession).toHaveBeenCalledWith(expect.objectContaining({ teamMemberId: 'tm-1' }));
  });

  it('redirects with an error when the secret is wrong', async () => {
    const formData = new FormData();
    formData.set('secret', 'wrong');
    formData.set('team_member_id', 'tm-1');

    const response = await POST(new Request('http://localhost/api/internal-dogfood/session', {
      method: 'POST',
      body: formData,
    }));

    expect(response.headers.get('location')).toContain('error=invalid_secret');
    expect(resolveInternalDogfoodActor).not.toHaveBeenCalled();
  });
});
