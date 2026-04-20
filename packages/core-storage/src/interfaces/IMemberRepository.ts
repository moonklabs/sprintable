import type { PaginationOptions } from '../types';

export interface Member {
  id: string;
  org_id: string;
  user_id: string | null;
  name: string;
  type: 'human' | 'agent';
  avatar_url: string | null;
  agent_config: Record<string, unknown> | null;
  webhook_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateMemberInput {
  org_id: string;
  user_id?: string | null;
  name: string;
  type?: 'human' | 'agent';
  avatar_url?: string | null;
  agent_config?: Record<string, unknown> | null;
  webhook_url?: string | null;
  is_active?: boolean;
}

export interface UpdateMemberInput {
  name?: string;
  avatar_url?: string | null;
  webhook_url?: string | null;
  is_active?: boolean;
}

export interface MemberListFilters extends PaginationOptions {
  org_id: string;
  type?: 'human' | 'agent';
  is_active?: boolean;
}

export interface IMemberRepository {
  list(filters: MemberListFilters): Promise<Member[]>;
  getById(id: string): Promise<Member>;
  getByUserId(userId: string, orgId: string): Promise<Member | null>;
  /** human: (user_id, org_id) 기준 upsert; agent: 신규 insert */
  getOrCreate(input: CreateMemberInput): Promise<Member>;
  update(id: string, input: UpdateMemberInput): Promise<Member>;
  delete(id: string, orgId: string): Promise<void>;
}
