import { parseBody, createStandupFeedbackSchema } from '@sprintable/shared';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { createOssStandupFeedback, listOssStandupFeedbackByDate } from '@/lib/oss-standup';
import { StandupFeedbackService } from '@/services/standup';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const date = searchParams.get('date');
    if (!projectId || !date) return ApiErrors.badRequest('project_id and date required');

    if (isOssMode()) {
      return apiSuccess(await listOssStandupFeedbackByDate(projectId, date));
    }

    const dbClient: SupabaseClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const service = new StandupFeedbackService(dbClient);
    const feedback = await service.listByDate(projectId, date);
    return apiSuccess(feedback);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();

    const dbClient: SupabaseClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;

    const parsed = await parseBody(request, createStandupFeedbackSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    if (ossMode) {
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

    const { data: member, error: memberError } = await dbClient
      .from('team_members')
      .select('project_id, org_id')
      .eq('id', me.id)
      .single();
    if (memberError || !member) return ApiErrors.forbidden('Team member not found');

    const service = new StandupFeedbackService(dbClient);
    const feedback = await service.create({
      project_id: member.project_id,
      org_id: member.org_id,
      standup_entry_id: body.standup_entry_id,
      feedback_by_id: me.id,
      review_type: body.review_type ?? 'comment',
      feedback_text: body.feedback_text,
    });
    return apiSuccess(feedback, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
