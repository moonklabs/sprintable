import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { requireRole, ADMIN_ROLES } from '@/lib/role-guard';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

/** DELETE /api/invitations/[id] — pending 초대를 revoked 상태로 전환 */
export async function DELETE(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Invitations are not supported in OSS mode.', 501);
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (me.type !== 'agent') {
      const denied = await requireRole(supabase, me.org_id, ADMIN_ROLES, 'Admin access required to revoke invitations');
      if (denied) return denied;
    }

    const { data: invitation, error: fetchError } = await supabase
      .from('invitations')
      .select('id, org_id, status')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!invitation) return ApiErrors.notFound('Invitation not found');
    if (invitation.org_id !== me.org_id) return ApiErrors.forbidden('Forbidden');
    if ((invitation.status as string) !== 'pending') {
      return apiError('BAD_REQUEST', `Cannot revoke invitation with status: ${invitation.status}`, 400);
    }

    const { error: updateError } = await supabase
      .from('invitations')
      .update({ status: 'revoked' })
      .eq('id', id);

    if (updateError) throw updateError;
    return apiSuccess({ ok: true, id });
  } catch (err: unknown) { return handleApiError(err); }
}
