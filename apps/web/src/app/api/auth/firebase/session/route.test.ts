import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ csrfCheck: vi.fn() }));
vi.mock('@/lib/auth/csrf', () => ({ verifyCsrfOrigin: h.csrfCheck }));

import { POST } from './route';

function makeRequest(): Request {
  return new Request('http://localhost/api/auth/firebase/session', { method: 'POST', body: '{}' });
}

describe('POST /api/auth/firebase/session', () => {
  beforeEach(() => {
    h.csrfCheck.mockReset().mockReturnValue(null);
    delete process.env['FIREBASE_AUTH_ISSUE_SESSION'];
  });

  afterEach(() => {
    delete process.env['FIREBASE_AUTH_ISSUE_SESSION'];
  });

  it('returns 501 when FIREBASE_AUTH_ISSUE_SESSION is unset (default off)', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('NOT_ENABLED');
  });

  it('returns 501 when FIREBASE_AUTH_ISSUE_SESSION is explicitly false', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'false';
    const res = await POST(makeRequest());
    expect(res.status).toBe(501);
  });

  it('still 501(not-implemented) even when flag is true — scaffold only, no live exchange yet', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'true';
    const res = await POST(makeRequest());
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('NOT_IMPLEMENTED');
  });
});
