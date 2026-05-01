// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;


const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['active'],
  active: ['done', 'archived'],
  done: [],
  archived: [],
};

export function validateStatusTransition(from: string, to: string): void {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw Object.assign(
      new Error(`Cannot transition epic from '${from}' to '${to}'`),
      { code: 'INVALID_TRANSITION' },
    );
  }
}

const ROLE_RANK: Record<string, number> = { owner: 3, admin: 2, member: 1 };

export async function getEpicActorRole(
  supabase: SupabaseClient,
  memberId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('team_members')
    .select('role')
    .eq('id', memberId)
    .maybeSingle();
  return (data as { role: string } | null)?.role ?? null;
}

export function hasEpicRole(role: string, minRole: 'admin' | 'owner'): boolean {
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minRole] ?? 999);
}
