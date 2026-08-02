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

  // story #1933 — request.url을 base로 쓰면 Cloud Run 내부 주소가 샌다. resolveAppUrl(null)이
  // 항상 공개 주소를 강제하는지 여기서 고정한다(요청이 내부 run.app 호스트로 들어와도 무관).
  it('redirect Location uses the configured public app URL, never the request origin (Cloud Run internal address never leaks)', async () => {
    const originalAppUrl = process.env['NEXT_PUBLIC_APP_URL'];
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://dev-app.sprintable.ai';
    try {
      const formData = new FormData();
      formData.set('secret', 'wrong');
      formData.set('team_member_id', 'tm-1');

      const response = await POST(new Request(
        'https://sprintable-frontend-dev-57iommnikq-du.a.run.app/api/internal-dogfood/session',
        { method: 'POST', body: formData },
      ));

      const location = response.headers.get('location') ?? '';
      expect(location).toBe('https://dev-app.sprintable.ai/internal-dogfood?error=invalid_secret');
      expect(location).not.toContain('run.app');
    } finally {
      if (originalAppUrl === undefined) delete process.env['NEXT_PUBLIC_APP_URL'];
      else process.env['NEXT_PUBLIC_APP_URL'] = originalAppUrl;
    }
  });
});
