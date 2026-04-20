import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  IProjectPermissionsRepository,
  ProjectPermissions,
  UpsertProjectPermissionsInput,
  ProjectPermissionKey,
} from '@sprintable/core-storage';
import { mapSupabaseError } from './utils';

const DEFAULT_PERMISSIONS: Record<ProjectPermissionKey, boolean> = {
  read: true,
  write: true,
  manage: false,
};

export class SupabaseProjectPermissionsRepository implements IProjectPermissionsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async listByMember(memberId: string): Promise<ProjectPermissions[]> {
    const { data, error } = await this.supabase
      .from('project_permissions')
      .select('*')
      .eq('member_id', memberId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ProjectPermissions[];
  }

  async listByProject(projectId: string): Promise<ProjectPermissions[]> {
    const { data, error } = await this.supabase
      .from('project_permissions')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ProjectPermissions[];
  }

  async get(memberId: string, projectId: string): Promise<ProjectPermissions | null> {
    const { data, error } = await this.supabase
      .from('project_permissions')
      .select('*')
      .eq('member_id', memberId)
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) throw mapSupabaseError(error);
    return (data ?? null) as ProjectPermissions | null;
  }

  async upsert(input: UpsertProjectPermissionsInput): Promise<ProjectPermissions> {
    const permissions = { ...DEFAULT_PERMISSIONS, ...(input.permissions ?? {}) };
    const { data, error } = await this.supabase
      .from('project_permissions')
      .upsert(
        {
          member_id: input.member_id,
          project_id: input.project_id,
          role: input.role ?? 'member',
          permissions,
        },
        { onConflict: 'member_id,project_id' }
      )
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as ProjectPermissions;
  }

  async hasPermission(memberId: string, projectId: string, permission: ProjectPermissionKey): Promise<boolean> {
    const perm = await this.get(memberId, projectId);
    if (!perm) return false;
    return (perm.permissions as Record<ProjectPermissionKey, boolean>)[permission] === true;
  }

  async delete(memberId: string, projectId: string): Promise<void> {
    const { error } = await this.supabase
      .from('project_permissions')
      .delete()
      .eq('member_id', memberId)
      .eq('project_id', projectId);
    if (error) throw mapSupabaseError(error);
  }
}
