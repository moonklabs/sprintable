import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * GET /api/docs/preview?q=<slug-or-uuid>
 */
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded)
      return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim();
    if (!q) return ApiErrors.badRequest('q is required');

    const _r = await proxyToFastapi(request, '/api/v2/docs/preview');
    if (!_r.ok) return _r;
    const data = await _r.json() as {
      id: string; title: string; icon: string | null; slug: string; embed_chain?: string[];
      // #2168 PR-①: 링크가 자기 project 를 실어 나르기 위한 3필드(additive).
      project_id: string; org_slug: string; project_slug: string | null;
    };
    return apiSuccess({
      id: data.id,
      title: data.title,
      icon: data.icon ?? null,
      slug: data.slug,
      embedChain: data.embed_chain ?? [],
      projectId: data.project_id,
      orgSlug: data.org_slug,
      projectSlug: data.project_slug ?? null,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
