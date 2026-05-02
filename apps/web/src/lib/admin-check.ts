
import type { SupabaseClient } from '@/types/supabase';
import { ForbiddenError } from '@/services/sprint';

/**
 * 현재 auth user가 org admin인지 체크
 * soft delete 시 기존 DELETE 정책(admin 전용) 권한 보존용
 */
export async function requireOrgAdmin(db: SupabaseClient, orgId: string) {
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new ForbiddenError('Not authenticated');

  const { data } = await db
    .from('team_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (!data || !['owner', 'admin'].includes(data.role as string)) {
    throw new ForbiddenError('Admin access required for delete operations');
  }
}

/** 현재 auth user가 org admin(owner/admin)인지 여부 반환 — 예외 없음 */
export async function isOrgAdmin(db: SupabaseClient, orgId: string): Promise<boolean> {
  const { data: { user } } = await db.auth.getUser();
  if (!user) return false;

  const { data } = await db
    .from('team_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  return !!data && ['owner', 'admin'].includes(data.role as string);
}
