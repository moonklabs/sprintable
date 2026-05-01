import { parseBody, createMeetingSchema } from '@sprintable/shared';
import { MeetingService } from '@/services/meeting';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { checkResourceLimit } from '@/lib/check-feature';

/** GET — 회의록 목록 */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    const { searchParams } = new URL(request.url);
    const page = Number(searchParams.get('page') ?? '1');
    const limit = Number(searchParams.get('limit') ?? '20');

    const service = new MeetingService(dbClient);
    const result = await service.list(me.project_id, page, limit);
    return apiSuccess(result.items, { total: result.total, page, limit });
  } catch (err: unknown) { return handleApiError(err); }
}

/** POST — 회의록 생성 */
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    // AC8: Feature gating
    const check = await checkResourceLimit(dbClient, me.org_id, 'max_meetings', 'meetings');
    if (!check.allowed) return apiError('UPGRADE_REQUIRED', check.reason ?? 'Meeting limit reached', 403);

    const parsed = await parseBody(request, createMeetingSchema);
    if (!parsed.success) return parsed.response;

    const service = new MeetingService(dbClient);
    const meeting = await service.create({
      project_id: me.project_id,
      ...parsed.data,
      created_by: me.id,
    });
    return apiSuccess(meeting, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
