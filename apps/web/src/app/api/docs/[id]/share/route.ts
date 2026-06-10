import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createDocRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — current public-share state ({ enabled, token, share_url }). */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const repo = await createDocRepository();
    return apiSuccess(await repo.getShareState(id));
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — enable sharing (opt-in); mints an opaque token. */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const repo = await createDocRepository();
    return apiSuccess(await repo.enableShare(id));
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** DELETE — revoke sharing; the token dies immediately. */
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const repo = await createDocRepository();
    await repo.disableShare(id);
    return apiSuccess({ enabled: false, token: null, share_url: null });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
