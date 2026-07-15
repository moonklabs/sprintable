// story 7d6b770b: getServerSession()이 JWT app_metadata의 org_id/project_id를 노출하는지
// 실 서명토큰(jose SignJWT, BE create_access_token과 동일 HS256+JWT_SECRET)으로 round-trip
// 검증. malformed/missing claim은 null(fail-closed) — 호출부가 /me fallback으로 넘어가게.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

const { cookiesGetMock, verifySprintableSessionMock } = vi.hoisted(() => ({
  cookiesGetMock: vi.fn(),
  verifySprintableSessionMock: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookiesGetMock })),
}));

vi.mock('@/lib/auth/firebase-session', () => ({
  SP_FS_COOKIE: '__Host-sp_fs',
  verifySprintableSession: (...args: unknown[]) => verifySprintableSessionMock(...args),
}));

const JWT_SECRET = 'test-secret-7d6b770b';

// story 360dcdf9: cookies().get(name)이 이제 SP_FS_COOKIE(__Host-sp_fs)도 조회하므로, 기존처럼
// 인자 무관 단일 mockReturnValue를 쓰면 sp_at 테스트들이 firebase 분기로 오탐 라우팅된다 —
// 키별로 분기하는 헬퍼로 교체(기존 테스트 의미는 완전히 동일하게 유지).
function mockSpAtCookie(token: string): void {
  cookiesGetMock.mockImplementation((name: string) => (name === 'sp_at' ? { value: token } : undefined));
}

function mockCookies(byName: Record<string, string | undefined>): void {
  cookiesGetMock.mockImplementation((name: string) => {
    const value = byName[name];
    return value === undefined ? undefined : { value };
  });
}

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
    mockSpAtCookie(token);

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).not.toBeNull();
    expect(session?.org_id).toBe('org-1');
    expect(session?.project_id).toBe('proj-1');
    expect(session?.user_id).toBe('user-1');
  });

  it('app_metadata 없음 → org_id/project_id null(fail-closed, /me fallback 유도)', async () => {
    const token = await signAccessToken({ email: 'u@test.com' });
    mockSpAtCookie(token);

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).not.toBeNull();
    expect(session?.org_id).toBeNull();
    expect(session?.project_id).toBeNull();
  });

  it('app_metadata가 malformed(배열/원시값)여도 null(크래시 아님)', async () => {
    const token = await signAccessToken({ email: 'u@test.com', app_metadata: ['not', 'an', 'object'] });
    mockSpAtCookie(token);

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
    mockSpAtCookie(expiredToken);

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
    mockSpAtCookie(tamperedToken);

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

// story 360dcdf9(E-AUTH-REBUILD Phase2-FE-S2·doc §4.1/§4.3): __Host-sp_fs 존재 시 Firebase
// 경로만 시도(legacy 폴백 절대 금지) → 성공하면 FastAPI GET /api/v2/me로 user_id/org_id/
// project_id 해석. React.cache()의 요청스코프 dedup 자체는 Next.js 렌더 디스패처가 있어야
// 동작하는 프로퍼티라(실측: 순수 node/vitest 환경에서 cache()는 매 호출마다 재실행됨 — 이
// 저장소의 기존 선례 auth-helpers.ts::getAuthContext도 동일 이유로 dedup을 유닛테스트하지
// 않는다) 여기서도 함수 자체의 정확성만 검증하고 dedup은 라이브/Next 요청 컨텍스트에서만
// 실측 가능하다고 명시한다(no-fiction — vitest로 증명 불가한 걸 증명한 척 안 함).
describe('getServerSession — Firebase 세션쿠키(__Host-sp_fs) 라우팅', () => {
  const ORIGINAL_FETCH = global.fetch;

  beforeEach(() => {
    cookiesGetMock.mockReset();
    verifySprintableSessionMock.mockReset();
    process.env['JWT_SECRET'] = JWT_SECRET;
    process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'] = 'test-project';
  });

  afterEach(() => {
    vi.resetModules();
    global.fetch = ORIGINAL_FETCH;
  });

  it('__Host-sp_fs 쿠키가 있으면 sp_at이 있어도 Firebase 경로를 우선한다', async () => {
    mockCookies({ '__Host-sp_fs': 'fs-cookie-value', sp_at: 'should-be-ignored' });
    verifySprintableSessionMock.mockResolvedValue({
      issuer: 'https://session.firebase.google.com/test-project',
      firebaseUid: 'fb-uid-1',
      email: 'fb-user@test.com',
      authTime: 1700000000,
    });
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({ member_id: 'sprintable-user-1', org_id: 'org-9', project_id: 'proj-9', resolved_default_project_id: null }),
      { status: 200 },
    )) as unknown as typeof fetch;

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).toEqual({
      user_id: 'sprintable-user-1',
      email: 'fb-user@test.com',
      access_token: '',
      org_id: 'org-9',
      project_id: 'proj-9',
    });
    // legacy jwtVerify 경로로 안 샜는지 확인 — sp_at 쿠키가 아예 안 읽혔어야 함은 라우팅 순서로 보장.
    expect(verifySprintableSessionMock).toHaveBeenCalledWith('fs-cookie-value', 'test-project');
  });

  it('Firebase 검증 실패 시 legacy 폴백 없이 null을 반환한다(다운그레이드 금지)', async () => {
    // sp_at을 실제로 유효한(정상 서명된) legacy 토큰으로 둬야 "폴백이 있었다면 성공했을 것"이
    // 판별 가능하다 — 무효 문자열이면 폴백이 있어도 어차피 null이라 이 테스트가 무력화된다.
    const validLegacyToken = await signAccessToken({
      email: 'legacy@test.com',
      app_metadata: { org_id: 'org-legacy', project_id: 'proj-legacy' },
    });
    mockCookies({ '__Host-sp_fs': 'invalid-fs-cookie', sp_at: validLegacyToken });
    verifySprintableSessionMock.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); // 검증 실패면 /me도 호출 안 함(불필요 왕복 방지).
  });

  it('GET /api/v2/me 호출이 실패(!ok)하면 null을 반환한다', async () => {
    mockCookies({ '__Host-sp_fs': 'fs-cookie-value' });
    verifySprintableSessionMock.mockResolvedValue({
      issuer: 'https://session.firebase.google.com/test-project',
      firebaseUid: 'fb-uid-1',
      email: 'fb-user@test.com',
      authTime: 1700000000,
    });
    global.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).toBeNull();
  });

  it('NEXT_PUBLIC_FIREBASE_PROJECT_ID 미설정이면 verifySprintableSession조차 호출하지 않고 null(config 부재 무해)', async () => {
    delete process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'];
    mockCookies({ '__Host-sp_fs': 'fs-cookie-value' });
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session).toBeNull();
    expect(verifySprintableSessionMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('__Host-sp_fs 쿠키가 없으면 legacy 경로는 Firebase 검증/네트워크 호출 0회로 완전 무변화한다', async () => {
    const token = await signAccessToken({
      email: 'legacy@test.com',
      app_metadata: { org_id: 'org-legacy', project_id: 'proj-legacy' },
    });
    mockCookies({ sp_at: token });
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { getServerSession } = await import('./server');
    const session = await getServerSession();

    expect(session?.user_id).toBe('user-1');
    expect(session?.org_id).toBe('org-legacy');
    expect(verifySprintableSessionMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
