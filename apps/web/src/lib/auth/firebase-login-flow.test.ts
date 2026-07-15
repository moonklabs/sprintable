import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signInWithEmailAndPasswordMock = vi.fn();
const getFirebaseAuthMock = vi.fn();

vi.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: (...args: unknown[]) => signInWithEmailAndPasswordMock(...args),
}));

vi.mock('./firebase-client', () => ({
  getFirebaseAuth: () => getFirebaseAuthMock(),
}));

function mockAuth(signOut = vi.fn().mockResolvedValue(undefined)) {
  return { signOut };
}

function mockFetchResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('signInAndExchangeFirebaseSession (story a0118204 — doc §1.1/§4.4 클라 오케스트레이션)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns FIREBASE_DISABLED without calling Firebase SDK when config is absent (getFirebaseAuth→null)', async () => {
    getFirebaseAuthMock.mockResolvedValue(null);
    const { signInAndExchangeFirebaseSession } = await import('./firebase-login-flow');
    const result = await signInAndExchangeFirebaseSession('a@b.com', 'pw');
    expect(result).toEqual({ ok: false, error: { code: 'FIREBASE_DISABLED', message: 'Firebase auth is not configured' } });
    expect(signInWithEmailAndPasswordMock).not.toHaveBeenCalled();
  });

  it('does not call the session-exchange endpoint when Firebase sign-in itself fails (wrong password etc.)', async () => {
    getFirebaseAuthMock.mockResolvedValue(mockAuth());
    signInWithEmailAndPasswordMock.mockRejectedValue(new Error('auth/wrong-password'));
    const { signInAndExchangeFirebaseSession } = await import('./firebase-login-flow');
    const result = await signInAndExchangeFirebaseSession('a@b.com', 'wrong');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FIREBASE_SIGNIN_FAILED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts the ID token to /api/auth/firebase/session after successful Firebase sign-in', async () => {
    const getIdToken = vi.fn().mockResolvedValue('id-token-123');
    getFirebaseAuthMock.mockResolvedValue(mockAuth());
    signInWithEmailAndPasswordMock.mockResolvedValue({ user: { getIdToken } });
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse(false, 501, { error: { code: 'NOT_ENABLED', message: 'not enabled' } }));
    const { signInAndExchangeFirebaseSession } = await import('./firebase-login-flow');
    await signInAndExchangeFirebaseSession('a@b.com', 'pw');
    expect(fetch).toHaveBeenCalledWith('/api/auth/firebase/session', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ idToken: 'id-token-123' }),
    }));
  });

  it('surfaces the server 501 (server flag still off) as a clean error — current expected state until Didi flips FIREBASE_AUTH_ISSUE_SESSION', async () => {
    getFirebaseAuthMock.mockResolvedValue(mockAuth());
    signInWithEmailAndPasswordMock.mockResolvedValue({ user: { getIdToken: vi.fn().mockResolvedValue('tok') } });
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse(false, 501, { error: { code: 'NOT_ENABLED', message: 'Firebase session issuance is not enabled' } }));
    const { signInAndExchangeFirebaseSession } = await import('./firebase-login-flow');
    const result = await signInAndExchangeFirebaseSession('a@b.com', 'pw');
    expect(result).toEqual({ ok: false, error: { code: 'NOT_ENABLED', message: 'Firebase session issuance is not enabled' } });
  });

  it('clears client Firebase state (signOut) on exchange failure — never leaves a dangling client session', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    getFirebaseAuthMock.mockResolvedValue(mockAuth(signOut));
    signInWithEmailAndPasswordMock.mockResolvedValue({ user: { getIdToken: vi.fn().mockResolvedValue('tok') } });
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse(false, 501, { error: { code: 'NOT_ENABLED', message: 'not enabled' } }));
    const { signInAndExchangeFirebaseSession } = await import('./firebase-login-flow');
    await signInAndExchangeFirebaseSession('a@b.com', 'pw');
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('clears client Firebase state (signOut) on exchange success — server __Host-sp_fs cookie becomes SSOT', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    getFirebaseAuthMock.mockResolvedValue(mockAuth(signOut));
    signInWithEmailAndPasswordMock.mockResolvedValue({ user: { getIdToken: vi.fn().mockResolvedValue('tok') } });
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse(true, 200, {}));
    const { signInAndExchangeFirebaseSession } = await import('./firebase-login-flow');
    const result = await signInAndExchangeFirebaseSession('a@b.com', 'pw');
    expect(result).toEqual({ ok: true, error: null });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('returns NETWORK_ERROR (not a crash) when the fetch itself rejects', async () => {
    getFirebaseAuthMock.mockResolvedValue(mockAuth());
    signInWithEmailAndPasswordMock.mockResolvedValue({ user: { getIdToken: vi.fn().mockResolvedValue('tok') } });
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const { signInAndExchangeFirebaseSession } = await import('./firebase-login-flow');
    const result = await signInAndExchangeFirebaseSession('a@b.com', 'pw');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NETWORK_ERROR');
  });
});
