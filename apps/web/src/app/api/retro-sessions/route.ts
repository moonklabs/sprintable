import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { RetroSessionService } from '@/services/retro-session';

// GET /api/retro-sessions?project_id=X
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
    const service = new RetroSessionService(dbClient);
    const data = await service.listSessions(projectId);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// POST /api/retro-sessions
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const body = await request.json() as {
      project_id?: string;
      org_id?: string;
      title?: string;
      sprint_id?: string | null;
      created_by?: string;
    };
    if (!body.project_id) return ApiErrors.badRequest('project_id required');
    if (!body.org_id) return ApiErrors.badRequest('org_id required');
    if (!body.title) return ApiErrors.badRequest('title required');
    if (!body.created_by) return ApiErrors.badRequest('created_by required');

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new RetroSessionService(dbClient);
    const data = await service.createSession({
      org_id: body.org_id,
      project_id: body.project_id,
      title: body.title,
      sprint_id: body.sprint_id ?? null,
      created_by: body.created_by,
    });
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
