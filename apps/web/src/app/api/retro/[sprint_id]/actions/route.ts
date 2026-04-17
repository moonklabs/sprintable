import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { RetroService } from '@/services/retro';

type RouteParams = { params: Promise<{ sprint_id: string }> };

// POST /api/retro/:sprint_id/actions
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { sprint_id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const body = await request.json() as { title?: string; assignee_id?: string };
    if (!body.title) return ApiErrors.badRequest('title required');
    if (!body.assignee_id) return ApiErrors.badRequest('assignee_id required');

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new RetroService(dbClient);
    const data = await service.addActionBySprintId(projectId, sprint_id, body.title, body.assignee_id);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
