import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    const { id } = await context.params;

    const { data: target, error: targetError } = await supabase
      .from('team_members')
      .select('id, org_id, user_id, type, is_active')
      .eq('id', id)
      .maybeSingle();

    if (targetError) throw targetError;
    if (!target) return ApiErrors.notFound('Team member not found');
    if (target.org_id !== me.org_id) return ApiErrors.forbidden('Forbidden');
    if (!target.is_active) return apiSuccess({ ok: true, alreadyInactive: true });

    if (target.type === 'human' && target.user_id) {
      const { count, error: countError } = await supabase
        .from('team_members')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', me.org_id)
        .eq('user_id', target.user_id)
        .eq('type', 'human')
        .eq('is_active', true);

      if (countError) throw countError;
      if ((count ?? 0) <= 1) {
        return apiError('LAST_PROJECT_MEMBERSHIP', 'Cannot remove the last active project membership for this member.', 400);
      }
    }

    const { error: updateError } = await supabase
      .from('team_members')
      .update({ is_active: false })
      .eq('id', id);

    if (updateError) throw updateError;

    return apiSuccess({ ok: true, id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
