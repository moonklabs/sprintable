import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';

/** GET — 내 웹훅 설정 목록 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
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
  try {
    const supabase = await createSupabaseServerClient();
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
