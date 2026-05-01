import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';

/** GET — 내 웹훅 설정 목록 */
export async function GET() {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = null;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    const { data, error } = await supabase
      .from('webhook_configs')
      .select('*, projects(name)')
      .eq('member_id', me.id)
      .order('created_at');

    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}

/** PUT — 웹훅 설정 upsert */
export async function PUT(request: Request) {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = null;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    const body = await request.json();
    if (!body.url?.trim()) return ApiErrors.badRequest('url required');

    // project_id 기반 upsert
    const projectId = body.project_id ?? null;

    // 기존 설정 확인
    let query = supabase
      .from('webhook_configs')
      .select('id')
      .eq('member_id', me.id)
      .eq('org_id', me.org_id);

    if (projectId) {
      query = query.eq('project_id', projectId);
    } else {
      query = query.is('project_id', null);
    }

    const { data: existing } = await query.maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from('webhook_configs')
        .update({ url: body.url.trim(), events: body.events ?? ['*'], is_active: body.is_active ?? true })
        .eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('webhook_configs')
        .insert({
          org_id: me.org_id,
          member_id: me.id,
          project_id: projectId,
          url: body.url.trim(),
          events: body.events ?? ['*'],
        });
      if (error) throw error;
    }

    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}

/** DELETE — 웹훅 설정 삭제 (admin만) */
export async function DELETE(request: Request) {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = null;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    await requireOrgAdmin(supabase, me.org_id);

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return ApiErrors.badRequest('id required');

    const { error } = await supabase
      .from('webhook_configs')
      .delete()
      .eq('id', id)
      .eq('org_id', me.org_id);

    if (error) throw error;
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
