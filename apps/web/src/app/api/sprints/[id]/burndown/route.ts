import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { SprintService, NotFoundError } from '@/services/sprint';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id/burndown
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const service = new SprintService(dbClient);
    const data = await service.getBurndown(id);
    return apiSuccess(data);
  } catch (err: unknown) {
    if (err instanceof NotFoundError) return ApiErrors.notFound(err.message);
    return handleApiError(err);
  }
}
