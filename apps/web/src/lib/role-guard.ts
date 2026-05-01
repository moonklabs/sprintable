import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiErrors } from '@/lib/api-response';

export const ADMIN_ROLES = ['owner', 'admin'] as const;
export const EDIT_ROLES = ['owner', 'admin', 'po'] as const;
export type RoleGuardRole = typeof ADMIN_ROLES[number] | typeof EDIT_ROLES[number];

/** Fetch the caller's role in the org. Returns null if unauthenticated or not a member. */
export async function getCallerRole(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('team_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  return (data?.role as string) ?? null;
}

/**
 * Assert that the caller has one of the required roles.
 * Returns an ApiErrors.forbidden() Response if not, null if allowed.
 * OSS mode always passes (isOssMode check must be done by caller before invoking).
 */
export async function requireRole(
  supabase: SupabaseClient,
  orgId: string,
  roles: readonly string[],
  message?: string,
): Promise<Response | null> {
  const role = await getCallerRole(supabase, orgId);
  if (!role || !roles.includes(role)) {
    return ApiErrors.forbidden(message ?? `Required role: ${roles.join(' | ')}`);
  }
  return null;
}
