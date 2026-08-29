import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * GET /api/visual-artifacts/preview?id=<uuid>
 *
 * story #3208 — `apps/web/src/app/api/docs/preview/route.ts`(#2168)와 동형. 아티팩트
 * 직URL·채팅 임베드가 호출자의 «현재» project로만 스코프된 `GET /api/visual-artifacts/{id}`
 * (BE SEC-S8 project_id 필터)에 막혀 다른 프로젝트를 보던 중이면 대상이 실재해도 404였다 —
 * 이 프리뷰는 org 스코프로 먼저 찾고 실 접근권을 검증해 위치정보(project_id/org_slug/
 * project_slug)만 낸다(본문은 여전히 project_id를 안 뒤에 `GET /{id}`가 낸다).
 */
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded)
      return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id')?.trim();
    if (!id) return ApiErrors.badRequest('id is required');

    const _r = await proxyToFastapi(request, '/api/v2/visual-artifacts/preview');
    if (!_r.ok) return _r;
    const json = await _r.json() as {
      data?: { id: string; project_id: string; org_slug: string; project_slug: string | null };
    };
    if (!json.data) return ApiErrors.notFound('Artifact not found');
    return apiSuccess({
      id: json.data.id,
      projectId: json.data.project_id,
      orgSlug: json.data.org_slug,
      projectSlug: json.data.project_slug ?? null,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
