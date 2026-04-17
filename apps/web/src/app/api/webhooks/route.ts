import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

export async function GET(request: Request) {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();
    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    const { searchParams } = new URL(request.url);
    const targetId = searchParams.get('member_id') ?? me.id;
    if (targetId !== me.id) await requireOrgAdmin(supabase, me.org_id);
    const { data, error } = await supabase.from('webhook_configs').select('*').eq('member_id', targetId);
    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}

export async function PUT(request: Request) {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();
    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);
    const body = await request.json();
    const targetId = body.member_id ?? me.id;
    const { data: target } = await supabase.from('team_members').select('id').eq('id', targetId).eq('project_id', me.project_id).single();
    if (!target) return ApiErrors.badRequest('target member not in project');
    const { data, error } = await supabase.from('webhook_configs').upsert({
      org_id: me.org_id, member_id: targetId,
      url: body.url, secret: body.secret ?? null,
      events: body.events ?? [], is_active: body.is_active ?? true,
    }, { onConflict: 'member_id' }).select().single();
    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}
