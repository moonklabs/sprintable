import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { RetroSessionService } from '@/services/retro-session';
import type { RetroItemCategory } from '@/services/retro-session';
import { isOssMode } from '@/lib/storage/factory';
import { addOssRetroItem } from '@/lib/oss-retro';
import type { RetroCategory } from '@/lib/oss-retro';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/retro-sessions/:id/items?project_id=X
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

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new RetroSessionService(dbClient);
    const data = await service.listItems(id, projectId);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// POST /api/retro-sessions/:id/items
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const body = await request.json() as { category?: RetroItemCategory; text?: string; author_id?: string };
    if (!body.category) return ApiErrors.badRequest('category required');
    if (!body.text) return ApiErrors.badRequest('text required');
    const author_id = body.author_id ?? me.id;

    if (isOssMode()) {
      const data = addOssRetroItem({ session_id: id, project_id: projectId, category: body.category as RetroCategory, text: body.text!, author_id: author_id });
      return apiSuccess(data);
    }

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new RetroSessionService(dbClient);
    const data = await service.addItem({ session_id: id, project_id: projectId, category: body.category, text: body.text, author_id });
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
