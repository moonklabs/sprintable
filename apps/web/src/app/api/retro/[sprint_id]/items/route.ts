import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { RetroService } from '@/services/retro';
import type { RetroCategory } from '@/services/retro';

type RouteParams = { params: Promise<{ sprint_id: string }> };

// POST /api/retro/:sprint_id/items
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

    const body = await request.json() as { category?: RetroCategory; text?: string; author_id?: string };
    if (!body.category) return ApiErrors.badRequest('category required');
    if (!body.text) return ApiErrors.badRequest('text required');
    if (!body.author_id) return ApiErrors.badRequest('author_id required');

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new RetroService(dbClient);
    const data = await service.addItemBySprintId(projectId, sprint_id, body.category, body.text, body.author_id);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
