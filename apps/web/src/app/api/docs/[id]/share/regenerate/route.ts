import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createDocRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

/** POST — issue a fresh token; the previous one dies (leak defense). */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const repo = await createDocRepository();
    return apiSuccess(await repo.regenerateShare(id));
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
