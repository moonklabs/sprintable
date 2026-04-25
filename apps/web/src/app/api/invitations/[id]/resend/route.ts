import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { requireRole, ADMIN_ROLES } from '@/lib/role-guard';

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/invitations/[id]/resend — 토큰 갱신 + expires_at 연장 */
export async function POST(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Invitations are not supported in OSS mode.', 501);
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (me.type !== 'agent') {
      const denied = await requireRole(supabase, me.org_id, ADMIN_ROLES, 'Admin access required to resend invitations');
      if (denied) return denied;
    }

    const { data: invitation, error: fetchError } = await supabase
      .from('invitations')
      .select('id, org_id, status, email')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!invitation) return ApiErrors.notFound('Invitation not found');
    if (invitation.org_id !== me.org_id) return ApiErrors.forbidden('Forbidden');
    if ((invitation.status as string) !== 'pending') {
      return apiError('BAD_REQUEST', `Cannot resend invitation with status: ${invitation.status}`, 400);
    }

    const arr = new Uint8Array(32);
    globalThis.crypto.getRandomValues(arr);
    const newToken = Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: updated, error: updateError } = await supabase
      .from('invitations')
      .update({ token: newToken, expires_at: newExpiresAt })
      .eq('id', id)
      .select('id, token, email, expires_at, project_id')
      .single();

    if (updateError) throw updateError;

    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/invite?token=${updated.token}`;
    return apiSuccess({ ...updated, invite_url: inviteUrl });
  } catch (err: unknown) { return handleApiError(err); }
}
