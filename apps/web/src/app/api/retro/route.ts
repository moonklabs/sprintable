import { parseBody, createRetroSchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { RetroService } from '@/services/retro';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');
    const service = new RetroService(dbClient);
    return apiSuccess(await service.getSessions(projectId));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const parsed = await parseBody(request, createRetroSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const service = new RetroService(dbClient);
    const session = await service.createSession({
      org_id: me.org_id, project_id: body.project_id ?? me.project_id,
      sprint_id: body.sprint_id, title: body.title, created_by: me.id,
    });
    return apiSuccess(session, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
