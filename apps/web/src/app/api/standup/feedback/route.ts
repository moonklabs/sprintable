
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { createOssStandupFeedback, listOssStandupFeedbackByDate } from '@/lib/oss-standup';
import { parseBody, createStandupFeedbackSchema } from '@sprintable/shared';

export async function GET(request: Request) {
  try {
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

      const { searchParams } = new URL(request.url);
      const projectId = searchParams.get('project_id');
      const date = searchParams.get('date');
      if (!projectId || !date) return ApiErrors.badRequest('project_id and date required');

      return apiSuccess(await listOssStandupFeedbackByDate(projectId, date));
    }

    return proxyToFastapi(request, '/api/v2/standup/feedback');
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function POST(request: Request) {
  try {
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

      const parsed = await parseBody(request, createStandupFeedbackSchema);
      if (!parsed.success) return parsed.response;
      const body = parsed.data;

      const feedback = await createOssStandupFeedback({
        project_id: me.project_id,
        org_id: me.org_id,
        standup_entry_id: body.standup_entry_id,
        feedback_by_id: me.id,
        review_type: body.review_type ?? 'comment',
        feedback_text: body.feedback_text,
      });
      return apiSuccess(feedback, undefined, 201);
    }

    return proxyToFastapi(request, '/api/v2/standup/feedback');
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
