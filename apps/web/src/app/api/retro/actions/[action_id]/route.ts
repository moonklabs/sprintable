import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { RetroService } from '@/services/retro';
import type { ActionStatus } from '@/services/retro';

type RouteParams = { params: Promise<{ action_id: string }> };

// PATCH /api/retro/actions/:action_id
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { action_id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const body = await request.json() as { status?: ActionStatus };
    if (!body.status) return ApiErrors.badRequest('status required');

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new RetroService(dbClient);
    const data = await service.updateActionStatus(action_id, body.status);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
