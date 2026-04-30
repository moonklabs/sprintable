import type { SupabaseClient } from '@supabase/supabase-js';
import type { ITeamMemberRepository, TeamMember, CreateTeamMemberInput, UpdateTeamMemberInput, TeamMemberListFilters } from '@sprintable/core-storage';
import { ForbiddenError } from '@sprintable/core-storage';
import { fastapiCall, mapSupabaseError } from './utils';

export class SupabaseTeamMemberRepository implements ITeamMemberRepository {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly accessToken: string = '',
  ) {}

  private get fastapi(): boolean { return Boolean(this.accessToken); }

  async list(filters: TeamMemberListFilters): Promise<TeamMember[]> {
    if (this.fastapi) return fastapiCall<TeamMember[]>('GET', '/api/v2/team-members', this.accessToken, { query: { project_id: filters.project_id, type: filters.type, is_active: filters.is_active != null ? String(filters.is_active) : undefined } });
    let query = this.supabase.from('team_members').select('*').eq('org_id', filters.org_id).is('deleted_at', null).order('created_at', { ascending: true });
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
    if (this.fastapi) return fastapiCall<TeamMember>('GET', `/api/v2/team-members/${id}`, this.accessToken);
    const { data, error } = await this.supabase.from('team_members').select('*').eq('id', id).is('deleted_at', null).single();
    if (error) throw mapSupabaseError(error);
    return data as TeamMember;
  }

  async getByUserId(userId: string, orgId: string): Promise<TeamMember | null> {
    if (this.fastapi) {
      try {
        const members = await fastapiCall<TeamMember[]>('GET', '/api/v2/team-members', this.accessToken);
        return members.find((m) => (m as unknown as { user_id?: string }).user_id === userId) ?? null;
      } catch { return null; }
    }
    const { data, error } = await this.supabase.from('team_members').select('*').eq('user_id', userId).eq('org_id', orgId).is('deleted_at', null).maybeSingle();
    if (error) throw mapSupabaseError(error);
    return (data ?? null) as TeamMember | null;
  }

  async create(input: CreateTeamMemberInput): Promise<TeamMember> {
    if (this.fastapi) return fastapiCall<TeamMember>('POST', '/api/v2/team-members', this.accessToken, { body: input, orgId: input.org_id });
    const { data, error } = await this.supabase.from('team_members').insert({ org_id: input.org_id, project_id: input.project_id, user_id: input.user_id ?? null, name: input.name, email: input.email ?? null, role: input.role ?? 'member', type: input.type ?? 'human', is_active: input.is_active ?? true }).select().single();
    if (error) { if (error.code === '42501') throw new ForbiddenError('Permission denied'); throw error; }
    return data as TeamMember;
  }

  async update(id: string, input: UpdateTeamMemberInput): Promise<TeamMember> {
    if (this.fastapi) return fastapiCall<TeamMember>('PATCH', `/api/v2/team-members/${id}`, this.accessToken, { body: input });
    const ALLOWED: (keyof UpdateTeamMemberInput)[] = ['name', 'email', 'role', 'is_active'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) { if (key in input) patch[key] = input[key]; }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');
    const { data, error } = await this.supabase.from('team_members').update(patch).eq('id', id).is('deleted_at', null).select().single();
    if (error) throw mapSupabaseError(error);
    return data as TeamMember;
  }

  async delete(id: string, orgId: string): Promise<void> {
    if (this.fastapi) { await fastapiCall<void>('DELETE', `/api/v2/team-members/${id}`, this.accessToken); return; }
    const { error } = await this.supabase.from('team_members').update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('org_id', orgId);
    if (error) { if (error.code === '42501') throw new ForbiddenError('Permission denied'); throw error; }
  }
}
