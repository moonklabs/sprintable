import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createDocRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const repo = await createDocRepository();
      const doc = await repo.getById(id);
      return apiSuccess({ updated_at: doc.updated_at });
    }

    return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
