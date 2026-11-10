// story 4832 — «this account's e-mail is not verified yet», read with the person's own access token. Only an explicit «required» and an explicit «not
// verified» says yes; every other answer (verified · not required · missing fields · an error status · a thrown fetch · a slow backend) is «no line».
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ backendFetch: vi.fn() }));
vi.mock('@/lib/backend-fetch', () => ({ backendFetch: h.backendFetch }));

import { emailUnverified } from './email-unverified';

const answer = (body: unknown, ok = true) => h.backendFetch.mockResolvedValue({ ok, json: async () => body });

beforeEach(() => h.backendFetch.mockReset());

describe('emailUnverified', () => {
  it('asks the account endpoint with the person\'s own token, uncached, with a short time limit and no request to cancel with (a page render)', async () => {
    answer({ email_verified: false, email_verification_required: true });
    expect(await emailUnverified('tok-1')).toBe(true);
    const [url, init] = h.backendFetch.mock.calls[0]! as [string, Record<string, unknown>];
    expect(url.endsWith('/api/v2/auth/me')).toBe(true);
    expect((init['headers'] as Record<string, string>)['Authorization']).toBe('Bearer tok-1');
    expect(init['cache']).toBe('no-store');
    expect(init['request']).toBeNull();
    expect(init['timeoutMs']).toBe(3000); // a slow backend must not hold the card back
  });

  it.each([
    ['verified', { email_verified: true, email_verification_required: true }],
    ['verification not required here', { email_verified: false, email_verification_required: false }],
    ['required but the flag is unknown', { email_verified: null, email_verification_required: true }],
    ['the flag is false but «required» is unknown', { email_verified: false, email_verification_required: null }],
    ['neither field', {}],
    ['an empty body', null],
  ])('%s → no line', async (_n, body) => {
    answer(body);
    expect(await emailUnverified('t')).toBe(false);
  });

  it('an error status (a time-out comes back as a 503 envelope), a thrown fetch and an unreadable body are «no line» — never a throw', async () => {
    answer({ email_verified: false, email_verification_required: true }, false);
    expect(await emailUnverified('t')).toBe(false);
    h.backendFetch.mockRejectedValue(new Error('connection refused'));
    expect(await emailUnverified('t')).toBe(false);
    h.backendFetch.mockResolvedValue({ ok: true, json: async () => { throw new Error('not json'); } });
    expect(await emailUnverified('t')).toBe(false);
  });
});
