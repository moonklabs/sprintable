import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id/velocity — sprint velocity + title + status
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const { data, error } = await dbClient
      .from('sprints')
      .select('velocity, title, status')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return ApiErrors.notFound('Sprint not found');
      throw error;
    }
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}
