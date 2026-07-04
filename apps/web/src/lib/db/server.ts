import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';

export const SP_AT_COOKIE = 'sp_at';
export const SP_RT_COOKIE = 'sp_rt';

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

export async function getServerSession(): Promise<ServerSession | null> {
  const cookieStore = await cookies();
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
