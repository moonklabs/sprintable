import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id/summary — story count+points by status
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const { data: stories, error } = await dbClient
      .from('stories')
      .select('status, story_points')
      .eq('sprint_id', id);

    if (error) throw error;

    const summary: Record<string, { count: number; points: number }> = {};
    for (const s of stories ?? []) {
      if (!summary[s.status]) summary[s.status] = { count: 0, points: 0 };
      summary[s.status]!.count++;
      summary[s.status]!.points += (s.story_points as number) ?? 0;
    }
    return apiSuccess(summary);
  } catch (err: unknown) { return handleApiError(err); }
}
