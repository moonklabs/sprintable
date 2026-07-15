/**
 * story 386a8b56(E-AUTH-REBUILD M2 Phase1-S3·doc firebase-auth-identity-platform-migration-poc
 * §4.3): Firebase 세션쿠키 검증 — Node 런타임 전용(API route/layout). Edge(proxy.ts)에서 절대
 * import하지 않는다 — Edge는 라우팅 힌트만, 권위 검증은 여기(doc §4.3 명시 배치).
 *
 * jose 사용(firebase-admin 아님) — doc §4.3 "otherwise use jose" 경로. 이미 proxy.ts가 legacy
 * HS256 검증에 jose를 쓰고 있어 신규 의존성 0(발명 최소). Firebase 세션쿠키 공개키는 JWKS
 * 표준 포맷이 아닌 kid→PEM X.509 맵이라 jose의 커스텀 JWTVerifyGetKey로 직접 캐시+해석한다.
 */
import { importX509, jwtVerify, type JWTVerifyGetKey } from 'jose';

// Firebase 공식 문서(doc §14): 세션쿠키 검증용 공개키 — ID token용 URL과 다르다(혼동 시 issuer
// confusion — doc §4.2 명시 위험).
const FIREBASE_SESSION_PUBLIC_KEYS_URL = 'https://www.googleapis.com/identitytoolkit/v3/relyingparty/publicKeys';
const DEFAULT_KEY_CACHE_MS = 60 * 60 * 1000; // 1시간(Cache-Control 헤더 없을 때 폴백)
const MAX_KEY_CACHE_MS = 24 * 60 * 60 * 1000;

let _keyCache: { keys: Record<string, string>; expiresAt: number } | null = null;

/** 테스트 전용 — 모듈 레벨 키 캐시가 테스트 간 상태를 누출하지 않도록 초기화. */
export function _resetKeyCacheForTests(): void {
  _keyCache = null;
}

async function fetchPublicKeys(): Promise<Record<string, string>> {
  const now = Date.now();
  if (_keyCache && _keyCache.expiresAt > now) return _keyCache.keys;

  const res = await fetch(FIREBASE_SESSION_PUBLIC_KEYS_URL);
  if (!res.ok) throw new Error('firebase_public_keys_fetch_failed');
  const keys = await res.json() as Record<string, string>;

  const cacheControl = res.headers.get('cache-control') ?? '';
  const maxAgeMatch = /max-age=(\d+)/.exec(cacheControl);
  const maxAgeMs = maxAgeMatch
    ? Math.min(Number(maxAgeMatch[1]) * 1000, MAX_KEY_CACHE_MS)
    : DEFAULT_KEY_CACHE_MS;

  _keyCache = { keys, expiresAt: now + maxAgeMs };
  return keys;
}

const getKey: JWTVerifyGetKey = async (header) => {
  if (!header.kid) throw new Error('missing_kid');
  const keys = await fetchPublicKeys();
  const pem = keys[header.kid];
  if (!pem) throw new Error('unknown_kid');
  return importX509(pem, 'RS256');
};

export interface VerifiedFirebaseSession {
  issuer: string;
  firebaseUid: string;
  email: string | null;
  authTime: number;
}

/**
 * doc §4.2 정확 검증: alg=RS256(jose가 강제)·kid∈Google 공개키셋·iss=정확히 session issuer·
 * aud=정확히 projectId·sub 비어있지 않음·auth_time/iat/exp 유효. 순차 fallback 없음 — 실패 시
 * null(legacy로 다운그레이드 절대 금지, 호출부가 그렇게 처리해야 함 — doc §4.1).
 */
export async function verifySprintableSession(
  sessionCookie: string,
  projectId: string,
): Promise<VerifiedFirebaseSession | null> {
  try {
    const { payload } = await jwtVerify(sessionCookie, getKey, {
      issuer: `https://session.firebase.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
    });
    if (!payload.sub) return null;
    const authTime = typeof payload['auth_time'] === 'number' ? payload['auth_time'] : null;
    if (authTime === null) return null;
    return {
      issuer: String(payload.iss),
      firebaseUid: payload.sub,
      email: typeof payload['email'] === 'string' ? payload['email'] : null,
      authTime,
    };
  } catch {
    return null;
  }
}
