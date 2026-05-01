import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

/** DELETE /api/organizations/[id] — soft delete (owner only) */
export async function DELETE(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Organization management is not supported in OSS mode.', 501);
  try {
    const { id } = await params;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    // Owner-only check via org_members
    const { data: orgMember, error: memberError } = await supabase
      .from('org_members')
      .select('role')
      .eq('org_id', id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (memberError) throw memberError;
    if (!orgMember || orgMember.role !== 'owner') {
      return ApiErrors.forbidden('Owner access required to delete organization');
    }

    // Active subscription check → 409
    const { data: subscription } = await supabase
      .from('org_subscriptions')
      .select('id')
      .eq('org_id', id)
      .eq('status', 'active')
      .maybeSingle();

    if (subscription) {
      return apiError('CONFLICT', 'Cannot delete organization with an active subscription. Cancel your subscription first.', 409);
    }

    // Soft delete via admin client to bypass RLS UPDATE restriction
    const admin = (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) as any;
    const { error } = await admin
      .from('organizations')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null);

    if (error) throw error;
    return apiSuccess({ ok: true, id });
  } catch (err: unknown) { return handleApiError(err); }
}
