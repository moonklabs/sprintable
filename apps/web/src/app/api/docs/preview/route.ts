import { DocsService } from '@/services/docs';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { createDocRepository } from '@/lib/storage/factory';
import { extractEmbedIds } from './extract-embed-ids';

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

    const dbClient = undefined;
    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient);
    const doc = await service.getDocPreview(me.project_id, q);
    if (!doc) return ApiErrors.notFound('Document not found');

    // OSS: embed chain traversal 미지원 (raw DB 클라이언트 없음)
    const embedChain: string[] = [];

    return apiSuccess({
      id: doc.id,
      title: doc.title,
      icon: doc.icon ?? null,
      slug: doc.slug,
      embedChain,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// extractEmbedIds re-export for use in other modules if needed
export { extractEmbedIds };
