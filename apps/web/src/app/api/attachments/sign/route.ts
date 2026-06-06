import { getServerSession } from '@/lib/db/server';
import { getSignedReadUrl, GCS_MEMO_ATTACHMENTS_BUCKET } from '@/lib/gcs';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';

// a54ddc16: 첨부 auth-gated 서빙. public 버킷 직링크 → 이 라우트가 BE authorize(접근권+path
// 소속 2겹 방어) 통과 시에만 단기 만료 V4 서명 URL을 반환한다.
//
// GET /api/attachments/sign?path=<stored url|bare path>&conversation_id=<uuid>   (또는 story_id)
const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
const PUBLIC_PREFIX = `https://storage.googleapis.com/${GCS_MEMO_ATTACHMENTS_BUCKET}/`;

// stored url → canonical bare object path. BE `_canonical_object_path` 와 동일 규칙(반드시 정합).
// 신규 = bare path 그대로 · legacy = `https://storage.googleapis.com/{bucket}/{path}` → prefix 제거
// · 외부 도메인/타 버킷 = null(우리 객체 아님 → 차단).
function canonicalObjectPath(stored: string): string | null {
  if (!stored) return null;
  if (stored.startsWith(PUBLIC_PREFIX)) return stored.slice(PUBLIC_PREFIX.length);
  if (stored.includes('://')) return null;
  return stored;
}

export async function GET(request: Request) {
  try {
    const session = await getServerSession().catch(() => null);
    if (!session) return ApiErrors.unauthorized();

    const { searchParams } = new URL(request.url);
    const rawPath = searchParams.get('path');
    const conversationId = searchParams.get('conversation_id');
    const storyId = searchParams.get('story_id');

    if (!rawPath) return ApiErrors.badRequest('path is required');
    // BE 계약: 정확히 하나의 리소스(conversation_id XOR story_id).
    if ((conversationId === null) === (storyId === null)) {
      return ApiErrors.badRequest('exactly one of conversation_id or story_id is required');
    }

    const objectPath = canonicalObjectPath(rawPath);
    // bare object path(스킴 없음)만 허용 — injection 차단(BE와 동일 가드).
    if (!objectPath || objectPath.includes('://')) return ApiErrors.badRequest('invalid attachment path');

    // BE authorize — 요청자 접근권 + path 소속(구조 스코프 + canonical 정확 매치) 2겹 방어.
    // 세션 access_token(sp_at)을 Bearer로 전달. org는 BE가 토큰서 도출.
    const authUrl = new URL('/api/v2/attachments/authorize', FASTAPI_URL());
    authUrl.searchParams.set('path', objectPath);
    if (conversationId) authUrl.searchParams.set('conversation_id', conversationId);
    if (storyId) authUrl.searchParams.set('story_id', storyId);

    const authRes = await fetch(authUrl.toString(), {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: 'no-store',
    });
    if (authRes.status === 403) return ApiErrors.forbidden('첨부 접근 권한이 없습니다');
    if (!authRes.ok) return ApiErrors.badRequest('attachment authorization failed');

    // authorize 통과 — 단기 만료 서명 URL 발급.
    const url = await getSignedReadUrl(GCS_MEMO_ATTACHMENTS_BUCKET, objectPath);
    return apiSuccess({ url });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
