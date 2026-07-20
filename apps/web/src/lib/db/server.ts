import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';
import { cache } from 'react';
import { verifySprintableSession, SP_FS_COOKIE } from '@/lib/auth/firebase-session';

export const SP_AT_COOKIE = 'sp_at';
export const SP_RT_COOKIE = 'sp_rt';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export interface ServerSession {
  user_id: string;
  email: string;
  access_token: string;
  // story 7d6b770b: app_metadata.org_id/project_id는 BE(get_verified_org_id)가 이미 이
  // 서명검증된 claim으로 DB 왕복 없이 authz 스코프를 판단한다 — FE도 동일 claim을 읽으면
  // "authz-only"(org/project만 필요) BFF 라우트가 GET /api/v2/me 재호출을 생략할 수 있다.
  // 신규 네트워크 호출 0(이미 하던 jwtVerify 서명검증 결과에서 파싱만 추가). claim 부재/
  // malformed면 null(fail-closed) — 호출부가 /me fallback으로 넘어가게.
  org_id: string | null;
  project_id: string | null;
}

function getJwtSecretBytes(): Uint8Array {
  const secret = process.env['JWT_SECRET'] ?? '';
  return new TextEncoder().encode(secret);
}

function readStringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readAppMetadataClaims(payload: Record<string, unknown>): Pick<ServerSession, 'org_id' | 'project_id'> {
  const appMetadata = payload['app_metadata'];
  if (!appMetadata || typeof appMetadata !== 'object' || Array.isArray(appMetadata)) {
    return { org_id: null, project_id: null };
  }
  const metadata = appMetadata as Record<string, unknown>;
  return {
    org_id: readStringClaim(metadata['org_id']),
    project_id: readStringClaim(metadata['project_id']),
  };
}

interface AuthMeResponse {
  member_id: string;
  org_id: string | null;
  project_id: string | null;
  resolved_default_project_id: string | null;
}

/**
 * story 360dcdf9(E-AUTH-REBUILD Phase2-FE-S2·doc §4.1/§4.3): Firebase 세션쿠키 검증 후
 * Sprintable user_id/org_id/project_id 해석. 로컬 firebaseUid만으로는 이 값들을 알 수 없다 —
 * 디디군 dual-verifier 설계(PR#2197)가 custom claims를 신뢰하지 않고 매번 live DB에서
 * 재조회하기 때문(§3.3 resource-actual 원칙, staleness 방지). 그래서 legacy 경로(순수 로컬
 * JWT 디코드)와 달리 이 경로는 FastAPI `GET /api/v2/me` 왕복 1회가 필연적이다.
 *
 * `React.cache()`로 요청 스코프 memoize(오르테가군 권고) — 같은 요청 내 getServerSession()이
 * 여러 번 호출돼도 /me 왕복은 1회로 묶인다.
 *
 * story 360dcdf9 S4(#2199) 재검증에서 발견·정정: BE `get_current_user`(backend/app/
 * dependencies/auth.py)는 `HTTPBearer`로만 자격을 읽는다 — Cookie 추출 경로 자체가 backend에
 * 존재하지 않는다(`_resolve_firebase_session(token, db)`의 `token`은 항상 Authorization:
 * Bearer 헤더 값). 그래서 이 함수는 `__Host-sp_fs` 세션쿠키 값을 `Authorization: Bearer`로
 * 그대로 전달하고, `access_token`도 이 값으로 채운다 — 이렇게 하면
 * `fastapi-proxy.ts::resolveAuthHeader()`의 기존 Bearer 포워딩이 legacy와 동일하게 동작해
 * 별도 프록시 변경 없이 Firebase 세션도 `proxyToFastapi` 경유 API를 그대로 쓸 수 있다.
 * (PR#2198 최초 버전은 Cookie 헤더로 보내고 access_token을 빈 문자열로 남겼었는데, 둘 다
 * 이 재검증에서 실제 BE 계약과 어긋남이 확인되어 정정 — 플래그/발급로직 부재로 오늘은
 * 미도달이라 무해했지만 활성화됐다면 항상 401로 실패했을 것이다.)
 */
export const resolveFirebaseServerSession = cache(async (sessionCookie: string): Promise<ServerSession | null> => {
  const projectId = process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'] ?? '';
  if (!projectId) return null;

  const verified = await verifySprintableSession(sessionCookie, projectId);
  if (!verified) return null; // doc §4.1: 검증 실패 시 legacy 폴백 절대 금지 — 그냥 미인증 처리.

  // story 360dcdf9 S4 재검증에서 발견·수정: BE get_current_user는 HTTPBearer로만 자격을
  // 읽는다(backend/app/dependencies/auth.py — Cookie 추출 경로 자체가 존재하지 않음). 세션
  // 쿠키 값을 Cookie 헤더로 보내면 BE가 아예 못 읽어 항상 401 — Authorization: Bearer로
  // 그대로 전달해야 _resolve_firebase_session(token, db)가 검증할 수 있다.
  const res = await fetch(`${FASTAPI_URL()}/api/v2/me`, {
    headers: { Authorization: `Bearer ${sessionCookie}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;

  const me = await res.json().catch(() => null) as AuthMeResponse | null;
  if (!me?.member_id) return null;

  return {
    user_id: me.member_id,
    email: verified.email ?? '',
    // BE가 Bearer 자격으로 세션쿠키 값 자체를 그대로 검증하므로(위와 동일 자격), 이 값을
    // access_token으로 채워두면 fastapi-proxy.ts::resolveAuthHeader()의 기존 Bearer 포워딩이
    // Firebase 세션에도 별도 변경 없이 그대로 작동한다 — 앞서 PR#2198에서 "access_token=''
    // 이라 proxy 쪽에 별도 쿠키 forwarding이 필요하다"고 남긴 후속 갭 메모는 이 발견으로 철회.
    access_token: sessionCookie,
    org_id: me.org_id,
    project_id: me.project_id ?? me.resolved_default_project_id,
  };
});

export async function getServerSession(): Promise<ServerSession | null> {
  const cookieStore = await cookies();

  // doc §4.1 라우팅 순서: Firebase 세션쿠키가 있으면 그 경로만 시도한다(legacy 폴백 금지).
  const firebaseSessionCookie = cookieStore.get(SP_FS_COOKIE)?.value;
  if (firebaseSessionCookie) {
    return resolveFirebaseServerSession(firebaseSessionCookie);
  }

  const token = cookieStore.get(SP_AT_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecretBytes());
    if (payload['type'] !== 'access' || !payload.sub) return null;
    const claims = readAppMetadataClaims(payload);
    return {
      user_id: payload.sub,
      email: readStringClaim(payload['email']) ?? '',
      access_token: token,
      org_id: claims.org_id,
      project_id: claims.project_id,
    };
  } catch {
    return null;
  }
}
