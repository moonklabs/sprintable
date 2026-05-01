import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember, getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { requireRole, ADMIN_ROLES } from '@/lib/role-guard';
import { AuditLogService } from '@/services/audit-log.service';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Member management is not supported in OSS mode.', 501);
  try {
    // AC4: API Key로 접근하는 에이전트는 admin scope 필요
    const meScope = await getAuthContext(request);
    if (meScope?.type === 'agent' && !meScope.scope?.includes('admin')) {
      return ApiErrors.insufficientScope('admin');
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    const { id } = await context.params;

    const { data: target, error: targetError } = await supabase
      .from('team_members')
      .select('id, org_id, user_id, type, is_active, role')
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

    new AuditLogService((await (await import('@/lib/supabase/admin')).createSupabaseAdminClient())).log({
      org_id: me.org_id as string,
      actor_id: user.id,
      action: 'member_removed',
      target_user_id: (target.user_id as string | null) ?? null,
      old_role: (target.role as string | null) ?? null,
    }).catch(() => {});

    return apiSuccess({ ok: true, id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Member management is not supported in OSS mode.', 501);
  try {
    const meScope = await getAuthContext(request);
    if (meScope?.type === 'agent' && !meScope.scope?.includes('admin')) {
      return ApiErrors.insufficientScope('admin');
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    const { id } = await context.params;

    const { data: target, error: targetError } = await supabase
      .from('team_members')
      .select('id, org_id, user_id, role, is_active')
      .eq('id', id)
      .maybeSingle();

    if (targetError) throw targetError;
    if (!target) return ApiErrors.notFound('Team member not found');
    if (target.org_id !== me.org_id) return ApiErrors.forbidden('Forbidden');
    if (!target.is_active) return apiError('BAD_REQUEST', 'Cannot update inactive member', 400);

    const denied = await requireRole(supabase, me.org_id as string, ADMIN_ROLES, 'Admin access required to change member roles');
    if (denied) return denied;

    let body: unknown;
    try { body = await request.json(); } catch { return apiError('BAD_REQUEST', 'Invalid JSON', 400); }
    const { role: newRole } = body as { role?: string };
    if (!newRole) return apiError('BAD_REQUEST', 'role required', 400);

    const oldRole = target.role as string;

    const { data: updated, error: updateError } = await supabase
      .from('team_members')
      .update({ role: newRole })
      .eq('id', id)
      .select('id, name, type, role, user_id, project_id, is_active')
      .single();

    if (updateError) throw updateError;

    new AuditLogService((await (await import('@/lib/supabase/admin')).createSupabaseAdminClient())).log({
      org_id: me.org_id as string,
      actor_id: user.id,
      action: 'role_changed',
      target_user_id: (target.user_id as string | null) ?? null,
      old_role: oldRole,
      new_role: newRole,
    }).catch(() => {});

    return apiSuccess(updated);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
