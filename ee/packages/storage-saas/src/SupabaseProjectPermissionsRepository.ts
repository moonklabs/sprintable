import type { SupabaseClient } from '@supabase/supabase-js';

export interface ProjectPermission {
  id: string;
  member_id: string;
  project_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  permissions: { read: boolean; write: boolean; manage: boolean };
  created_at: string;
  updated_at: string;
}

export interface UpsertProjectPermissionInput {
  member_id: string;
  project_id: string;
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  permissions?: Partial<{ read: boolean; write: boolean; manage: boolean }>;
}

export class SupabaseProjectPermissionsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async upsert(input: UpsertProjectPermissionInput): Promise<ProjectPermission | null> {
    const role = input.role ?? 'member';
    const defaultManage = role === 'owner' || role === 'admin';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any)
      .from('project_permissions')
      .upsert(
        {
          member_id: input.member_id,
          project_id: input.project_id,
          role,
          permissions: {
            read: true,
            write: true,
            manage: defaultManage,
            ...input.permissions,
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'member_id,project_id', ignoreDuplicates: false },
      )
      .select('*')
      .single();
    if (error) return null;
    return data as ProjectPermission;
  }

  async get(memberId: string, projectId: string): Promise<ProjectPermission | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (this.supabase as any)
      .from('project_permissions')
      .select('*')
      .eq('member_id', memberId)
      .eq('project_id', projectId)
      .maybeSingle();
    return (data as ProjectPermission | null) ?? null;
  }

  async hasPermission(
    memberId: string,
    projectId: string,
    permission: 'read' | 'write' | 'manage',
  ): Promise<boolean> {
    const pp = await this.get(memberId, projectId);
    if (!pp) return false;
    return pp.permissions[permission] === true;
  }

  async delete(memberId: string, projectId: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (this.supabase as any)
      .from('project_permissions')
      .delete()
      .eq('member_id', memberId)
      .eq('project_id', projectId);
    return !error;
  }
}
