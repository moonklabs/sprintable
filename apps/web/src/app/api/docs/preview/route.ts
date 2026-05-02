import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { isOssMode, createDocRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * GET /api/docs/preview?q=<slug-or-uuid>
 */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded)
      return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim();
    if (!q) return ApiErrors.badRequest('q is required');

    if (isOssMode()) {
      const repo = await createDocRepository();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
      try {
        const doc = isUuid
          ? await repo.getById(q)
          : await (repo as unknown as { getBySlug: (p: string, s: string) => Promise<{ id: string; title: string; icon: string | null; slug: string; content: string }> }).getBySlug(me.project_id, q);
        if (!doc) return ApiErrors.notFound('Document not found');
        return apiSuccess({ id: doc.id, title: doc.title, icon: doc.icon ?? null, slug: doc.slug, embedChain: [] });
      } catch {
        return ApiErrors.notFound('Document not found');
      }
    }

    const _r = await proxyToFastapi(request, '/api/v2/docs/preview');
    if (!_r.ok) return _r;
    const data = await _r.json() as { id: string; title: string; icon: string | null; slug: string; embed_chain?: string[] };
    return apiSuccess({
      id: data.id,
      title: data.title,
      icon: data.icon ?? null,
      slug: data.slug,
      embedChain: data.embed_chain ?? [],
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
