import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { RetroSessionService } from '@/services/retro-session';
import type { RetroSessionPhase } from '@/services/retro-session';
import { isOssMode } from '@/lib/storage/factory';
import { getOssRetroSession, listOssRetroItems, listOssRetroActions, advanceOssRetroPhase } from '@/lib/oss-retro';
import type { RetroPhase } from '@/lib/oss-retro';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/retro-sessions/:id?project_id=X
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    if (isOssMode()) {
      const session = await getOssRetroSession(id, projectId);
      if (!session) return ApiErrors.notFound('Session not found');
      const [items, actions] = await Promise.all([
        listOssRetroItems(id, projectId),
        listOssRetroActions(id, projectId),
      ]);
      return apiSuccess({ session, items, actions });
    }

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new RetroSessionService(dbClient);
    const data = await service.getSession(id, projectId);
    if (!data) return ApiErrors.notFound('Session not found');
    const [items, actions] = await Promise.all([
      service.listItems(id, projectId),
      service.listActions(id, projectId),
    ]);
    return apiSuccess({ session: data, items, actions });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PATCH /api/retro-sessions/:id — change phase
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const body = await request.json() as { phase?: RetroSessionPhase };
    if (!body.phase) return ApiErrors.badRequest('phase required');

    if (isOssMode()) {
      const data = await advanceOssRetroPhase(id, projectId, body.phase as RetroPhase);
      return apiSuccess(data);
    }

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new RetroSessionService(dbClient);
    const data = await service.changePhase(id, projectId, body.phase);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
