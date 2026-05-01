import { parseBody, updateStandupFeedbackSchema } from '@sprintable/shared';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import {
  deleteOssStandupFeedback,
  listOssStandupFeedbackForEntry,
  updateOssStandupFeedback,
} from '@/lib/oss-standup';
import { StandupFeedbackService } from '@/services/standup';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/standup/feedback/:entry_id — list all feedback for a standup entry
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: entryId } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      return apiSuccess(await listOssStandupFeedbackForEntry(entryId));
    }

    const dbClient: SupabaseClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const { data, error } = await dbClient
      .from('standup_feedback')
      .select('*')
      .eq('standup_entry_id', entryId)
      .order('created_at');
    if (error) throw error;
    return apiSuccess(data ?? []);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const dbClient: SupabaseClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;

    const parsed = await parseBody(request, updateStandupFeedbackSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    if (isOssMode()) {
      return apiSuccess(await updateOssStandupFeedback(id, body, me.id));
    }

    const service = new StandupFeedbackService(dbClient);
    const feedback = await service.update(id, body, me.id);
    return apiSuccess(feedback);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      await deleteOssStandupFeedback(id, me.id);
      return apiSuccess({ ok: true });
    }

    const dbClient: SupabaseClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const service = new StandupFeedbackService(dbClient);
    await service.delete(id, me.id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
