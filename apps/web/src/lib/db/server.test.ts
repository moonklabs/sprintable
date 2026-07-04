// story 7d6b770b: getServerSession()이 JWT app_metadata의 org_id/project_id를 노출하는지
// 실 서명토큰(jose SignJWT, BE create_access_token과 동일 HS256+JWT_SECRET)으로 round-trip
// 검증. malformed/missing claim은 null(fail-closed) — 호출부가 /me fallback으로 넘어가게.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

const { cookiesGetMock } = vi.hoisted(() => ({
  cookiesGetMock: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookiesGetMock })),
}));

const JWT_SECRET = 'test-secret-7d6b770b';

async function signAccessToken(payload: Record<string, unknown>): Promise<string> {
  const secretBytes = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({ type: 'access', ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject((payload['sub'] as string) ?? 'user-1')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secretBytes);
}

describe('getServerSession — JWT app_metadata org_id/project_id claim', () => {
  beforeEach(() => {
    cookiesGetMock.mockReset();
    process.env['JWT_SECRET'] = JWT_SECRET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('app_metadata.org_id/project_id가 있으면 그대로 노출', async () => {
    const token = await signAccessToken({
      email: 'u@test.com',
      app_metadata: { org_id: 'org-1', project_id: 'proj-1' },
    });
    cookiesGetMock.mockReturnValue({ value: token });

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).not.toBeNull();
    expect(session?.org_id).toBe('org-1');
    expect(session?.project_id).toBe('proj-1');
    expect(session?.user_id).toBe('user-1');
  });

  it('app_metadata 없음 → org_id/project_id null(fail-closed, /me fallback 유도)', async () => {
    const token = await signAccessToken({ email: 'u@test.com' });
    cookiesGetMock.mockReturnValue({ value: token });

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).not.toBeNull();
    expect(session?.org_id).toBeNull();
    expect(session?.project_id).toBeNull();
  });

  it('app_metadata가 malformed(배열/원시값)여도 null(크래시 아님)', async () => {
    const token = await signAccessToken({ email: 'u@test.com', app_metadata: ['not', 'an', 'object'] });
    cookiesGetMock.mockReturnValue({ value: token });

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).not.toBeNull();
    expect(session?.org_id).toBeNull();
    expect(session?.project_id).toBeNull();
  });

  it('만료된 토큰 → null(fail-open 아님)', async () => {
    const secretBytes = new TextEncoder().encode(JWT_SECRET);
    const expiredToken = await new SignJWT({
      type: 'access',
      app_metadata: { org_id: 'org-1', project_id: 'proj-1' },
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(secretBytes);
    cookiesGetMock.mockReturnValue({ value: expiredToken });

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).toBeNull();
  });

  it('변조된(다른 secret으로 서명된) 토큰 → null', async () => {
    const wrongSecretBytes = new TextEncoder().encode('wrong-secret');
    const tamperedToken = await new SignJWT({
      type: 'access',
      app_metadata: { org_id: 'org-1', project_id: 'proj-1' },
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(wrongSecretBytes);
    cookiesGetMock.mockReturnValue({ value: tamperedToken });

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).toBeNull();
  });

  it('쿠키 없음 → null', async () => {
    cookiesGetMock.mockReturnValue(undefined);

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).toBeNull();
  });
});
