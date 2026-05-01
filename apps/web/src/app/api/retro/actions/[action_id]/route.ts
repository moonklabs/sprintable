import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { RetroService } from '@/services/retro';
import type { ActionStatus } from '@/services/retro';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

type RouteParams = { params: Promise<{ action_id: string }> };

// PATCH /api/retro/actions/:action_id
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { action_id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const body = await request.json() as { status?: ActionStatus };
    if (!body.status) return ApiErrors.badRequest('status required');

    const dbClient: SupabaseClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const service = new RetroService(dbClient);
    const data = await service.updateActionStatus(action_id, body.status);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
