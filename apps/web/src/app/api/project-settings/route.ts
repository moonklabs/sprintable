import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';

// GET /api/project-settings?project_id=
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    if (isOssMode()) return apiSuccess({ project_id: me.project_id, standup_deadline: '09:00' });

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id') ?? me.project_id;

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const { data } = await dbClient.from('project_settings').select('*').eq('project_id', projectId).maybeSingle();
    return apiSuccess(data ?? { project_id: projectId, standup_deadline: '09:00' });
  } catch (err: unknown) { return handleApiError(err); }
}

// PATCH /api/project-settings
export async function PATCH(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    if (isOssMode()) return ApiErrors.notFound('Not supported in OSS mode');

    const body = await request.json() as { project_id?: string; standup_deadline?: string };
    const projectId = body.project_id ?? me.project_id;

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const { data, error } = await dbClient
      .from('project_settings')
      .upsert({ project_id: projectId, standup_deadline: body.standup_deadline ?? '09:00', updated_at: new Date().toISOString() }, { onConflict: 'project_id' })
      .select()
      .single();
    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}
