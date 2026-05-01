import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { requireRole, EDIT_ROLES } from '@/lib/role-guard';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

// GET /api/project-settings?project_id=
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    if (isOssMode()) return apiSuccess({ project_id: me.project_id, standup_deadline: '09:00' });

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id') ?? me.project_id;

    const dbClient: SupabaseClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const { data } = await dbClient.from('project_settings').select('*').eq('project_id', projectId).maybeSingle();
    return apiSuccess(data ?? { project_id: projectId, standup_deadline: '09:00' });
  } catch (err: unknown) { return handleApiError(err); }
}

// PATCH /api/project-settings
export async function PATCH(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    if (isOssMode()) return ApiErrors.notFound('Not supported in OSS mode');

    if (me.type !== 'agent') {
      const denied = await requireRole(supabase, me.org_id, EDIT_ROLES, 'Admin or PO access required to update project settings');
      if (denied) return denied;
    }

    const body = await request.json() as { project_id?: string; standup_deadline?: string };
    const projectId = body.project_id ?? me.project_id;

    const dbClient: SupabaseClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const { data, error } = await dbClient
      .from('project_settings')
      .upsert({ project_id: projectId, standup_deadline: body.standup_deadline ?? '09:00', updated_at: new Date().toISOString() }, { onConflict: 'project_id' })
      .select()
      .single();
    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}
