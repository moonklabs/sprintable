
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import {
  deleteOssStandupFeedback,
  listOssStandupFeedbackForEntry,
  updateOssStandupFeedback,
} from '@/lib/oss-standup';
import { parseBody, updateStandupFeedbackSchema } from '@sprintable/shared';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/standup/feedback/:entry_id — list all feedback for a standup entry
export async function GET(request: Request, { params }: RouteParams) {
  try {
    if (isOssMode()) {
      const { id: entryId } = await params;
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
      return apiSuccess(await listOssStandupFeedbackForEntry(entryId));
    }

    const { id } = await params;
    return proxyToFastapi(request, `/api/v2/standup/feedback/${id}`);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    if (isOssMode()) {
      const { id } = await params;
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
      const parsed = await parseBody(request, updateStandupFeedbackSchema);
      if (!parsed.success) return parsed.response;
      return apiSuccess(await updateOssStandupFeedback(id, parsed.data, me.id));
    }

    const { id } = await params;
    return proxyToFastapi(request, `/api/v2/standup/feedback/${id}`);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    if (isOssMode()) {
      const { id } = await params;
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
      await deleteOssStandupFeedback(id, me.id);
      return apiSuccess({ ok: true });
    }

    const { id } = await params;
    return proxyToFastapi(request, `/api/v2/standup/feedback/${id}`);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
