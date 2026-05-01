// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

export type AuditAction = 'member_added' | 'member_removed' | 'role_changed';

export interface AuditLogInput {
  org_id: string;
  actor_id: string;
  action: AuditAction;
  target_user_id?: string | null;
  old_role?: string | null;
  new_role?: string | null;
  metadata?: Record<string, unknown>;
}

export class AuditLogService {
  constructor(private readonly supabase: SupabaseClient) {}

  async log(input: AuditLogInput): Promise<void> {
    await this.supabase.from('permission_audit_logs').insert({
      org_id: input.org_id,
      actor_id: input.actor_id,
      action: input.action,
      target_user_id: input.target_user_id ?? null,
      old_role: input.old_role ?? null,
      new_role: input.new_role ?? null,
      metadata: input.metadata ?? {},
    });
  }

  async list(orgId: string, limit = 50, cursor?: string) {
    let query = this.supabase
      .from('permission_audit_logs')
      .select('id, org_id, actor_id, action, target_user_id, old_role, new_role, metadata, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (cursor) query = query.lt('created_at', cursor);
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }
}
