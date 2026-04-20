export type ProjectPermissionKey = 'read' | 'write' | 'manage';

export interface ProjectPermissions {
  id: string;
  member_id: string;
  project_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  permissions: Record<ProjectPermissionKey, boolean>;
  created_at: string;
  updated_at: string;
}

export interface UpsertProjectPermissionsInput {
  member_id: string;
  project_id: string;
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  permissions?: Partial<Record<ProjectPermissionKey, boolean>>;
}

export interface IProjectPermissionsRepository {
  listByMember(memberId: string): Promise<ProjectPermissions[]>;
  listByProject(projectId: string): Promise<ProjectPermissions[]>;
  get(memberId: string, projectId: string): Promise<ProjectPermissions | null>;
  upsert(input: UpsertProjectPermissionsInput): Promise<ProjectPermissions>;
  hasPermission(memberId: string, projectId: string, permission: ProjectPermissionKey): Promise<boolean>;
  delete(memberId: string, projectId: string): Promise<void>;
}
