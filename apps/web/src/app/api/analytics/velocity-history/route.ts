import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { AnalyticsService } from '@/services/analytics';

// GET /api/analytics/velocity-history?project_id=X
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new AnalyticsService(dbClient);
    const data = await service.getVelocityHistory(projectId);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
