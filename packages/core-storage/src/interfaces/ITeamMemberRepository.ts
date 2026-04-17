import type { PaginationOptions } from '../types';

export interface TeamMember {
  id: string;
  org_id: string;
  project_id: string;
  user_id: string | null;
  name: string;
  email: string | null;
  role: string;
  type: 'human' | 'agent';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateTeamMemberInput {
  org_id: string;
  project_id: string;
  user_id?: string | null;
  name: string;
  email?: string | null;
  role?: string;
  type?: 'human' | 'agent';
  is_active?: boolean;
}

export interface UpdateTeamMemberInput {
  name?: string;
  email?: string | null;
  role?: string;
  is_active?: boolean;
}

export interface TeamMemberListFilters extends PaginationOptions {
  org_id: string;
  project_id?: string;
  type?: 'human' | 'agent';
  is_active?: boolean;
}

export interface ITeamMemberRepository {
  list(filters: TeamMemberListFilters): Promise<TeamMember[]>;
  getById(id: string): Promise<TeamMember>;
  getByUserId(userId: string, orgId: string): Promise<TeamMember | null>;
  create(input: CreateTeamMemberInput): Promise<TeamMember>;
  update(id: string, input: UpdateTeamMemberInput): Promise<TeamMember>;
  delete(id: string, orgId: string): Promise<void>;
}
