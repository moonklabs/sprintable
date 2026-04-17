import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ITeamMemberRepository,
  TeamMember,
  CreateTeamMemberInput,
  UpdateTeamMemberInput,
  TeamMemberListFilters,
} from '@sprintable/core-storage';
import { ForbiddenError } from '@sprintable/core-storage';
import { mapSupabaseError } from './utils';

export class SupabaseTeamMemberRepository implements ITeamMemberRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(filters: TeamMemberListFilters): Promise<TeamMember[]> {
    let query = this.supabase
      .from('team_members')
      .select('*')
      .eq('org_id', filters.org_id)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (filters.project_id) query = query.eq('project_id', filters.project_id);
    if (filters.type) query = query.eq('type', filters.type);
    if (filters.is_active != null) query = query.eq('is_active', filters.is_active);
    if (filters.cursor) query = query.gt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as TeamMember[];
  }

  async getById(id: string): Promise<TeamMember> {
    const { data, error } = await this.supabase
      .from('team_members')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();
    if (error) throw mapSupabaseError(error);
    return data as TeamMember;
  }

  async getByUserId(userId: string, orgId: string): Promise<TeamMember | null> {
    const { data, error } = await this.supabase
      .from('team_members')
      .select('*')
      .eq('user_id', userId)
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw mapSupabaseError(error);
    return (data ?? null) as TeamMember | null;
  }

  async create(input: CreateTeamMemberInput): Promise<TeamMember> {
    const { data, error } = await this.supabase
      .from('team_members')
      .insert({
        org_id: input.org_id,
        project_id: input.project_id,
        user_id: input.user_id ?? null,
        name: input.name,
        email: input.email ?? null,
        role: input.role ?? 'member',
        type: input.type ?? 'human',
        is_active: input.is_active ?? true,
      })
      .select()
      .single();
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as TeamMember;
  }

  async update(id: string, input: UpdateTeamMemberInput): Promise<TeamMember> {
    const ALLOWED: (keyof UpdateTeamMemberInput)[] = ['name', 'email', 'role', 'is_active'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) {
      if (key in input) patch[key] = input[key];
    }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');

    const { data, error } = await this.supabase
      .from('team_members')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as TeamMember;
  }

  async delete(id: string, orgId: string): Promise<void> {
    const { error } = await this.supabase
      .from('team_members')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('org_id', orgId);
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
  }
}
