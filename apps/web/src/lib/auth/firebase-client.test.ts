import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initializeAppMock = vi.fn((_config: unknown) => ({ name: 'test-app' }));
const getAppsMock = vi.fn(() => [] as unknown[]);
const setPersistenceMock = vi.fn((_auth: unknown, _persistence: unknown) => Promise.resolve(undefined));
const getAuthMock = vi.fn((_app: unknown) => ({ name: 'test-auth' }));

vi.mock('firebase/app', () => ({
  initializeApp: (config: unknown) => initializeAppMock(config),
  getApps: () => getAppsMock(),
}));

vi.mock('firebase/auth', () => ({
  getAuth: (app: unknown) => getAuthMock(app),
  setPersistence: (auth: unknown, persistence: unknown) => setPersistenceMock(auth, persistence),
  inMemoryPersistence: 'in-memory',
}));

describe('getFirebaseAuth (story a0118204 — config 부재 시 무해, 절대 throw 안 함)', () => {
  const ENV_KEYS = ['NEXT_PUBLIC_FIREBASE_API_KEY', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_APP_ID'] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('returns null (not throw) when Firebase config env vars are entirely absent (PO 프로비저닝 전 상태)', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const { getFirebaseAuth, _resetFirebaseAppForTests } = await import('./firebase-client');
    _resetFirebaseAppForTests();
    await expect(getFirebaseAuth()).resolves.toBeNull();
    expect(initializeAppMock).not.toHaveBeenCalled();
  });

  it('returns null when config is partially present (e.g. apiKey missing) — no partial init', async () => {
    delete process.env['NEXT_PUBLIC_FIREBASE_API_KEY'];
    process.env['NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'] = 'x.firebaseapp.com';
    process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'] = 'x';
    process.env['NEXT_PUBLIC_FIREBASE_APP_ID'] = 'x';
    const { getFirebaseAuth, _resetFirebaseAppForTests } = await import('./firebase-client');
    _resetFirebaseAppForTests();
    await expect(getFirebaseAuth()).resolves.toBeNull();
  });

  it('initializes with inMemoryPersistence (server cookie is SSOT, never browserLocal) when config is complete', async () => {
    process.env['NEXT_PUBLIC_FIREBASE_API_KEY'] = 'key';
    process.env['NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'] = 'x.firebaseapp.com';
    process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'] = 'x';
    process.env['NEXT_PUBLIC_FIREBASE_APP_ID'] = 'x';
    const { getFirebaseAuth, _resetFirebaseAppForTests } = await import('./firebase-client');
    _resetFirebaseAppForTests();
    const auth = await getFirebaseAuth();
    expect(auth).not.toBeNull();
    expect(setPersistenceMock).toHaveBeenCalledWith(expect.anything(), 'in-memory');
  });
});
