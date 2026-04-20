import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  IMemberRepository,
  Member,
  CreateMemberInput,
  UpdateMemberInput,
  MemberListFilters,
} from '@sprintable/core-storage';
import { ForbiddenError } from '@sprintable/core-storage';
import { mapSupabaseError } from './utils';

export class SupabaseMemberRepository implements IMemberRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(filters: MemberListFilters): Promise<Member[]> {
    let query = this.supabase
      .from('members')
      .select('*')
      .eq('org_id', filters.org_id)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (filters.type) query = query.eq('type', filters.type);
    if (filters.is_active != null) query = query.eq('is_active', filters.is_active);
    if (filters.cursor) query = query.gt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Member[];
  }

  async getById(id: string): Promise<Member> {
    const { data, error } = await this.supabase
      .from('members')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();
    if (error) throw mapSupabaseError(error);
    return data as Member;
  }

  async getByUserId(userId: string, orgId: string): Promise<Member | null> {
    const { data, error } = await this.supabase
      .from('members')
      .select('*')
      .eq('user_id', userId)
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw mapSupabaseError(error);
    return (data ?? null) as Member | null;
  }

  async getOrCreate(input: CreateMemberInput): Promise<Member> {
    if (input.type === 'human' && input.user_id) {
      // human: (user_id, org_id) 기준 upsert
      const { data, error } = await this.supabase
        .from('members')
        .upsert(
          {
            org_id: input.org_id,
            user_id: input.user_id,
            name: input.name,
            type: 'human',
            avatar_url: input.avatar_url ?? null,
            is_active: input.is_active ?? true,
          },
          { onConflict: 'user_id,org_id', ignoreDuplicates: false }
        )
        .select()
        .single();
      if (error) {
        if (error.code === '42501') throw new ForbiddenError('Permission denied');
        throw error;
      }
      return data as Member;
    }

    // agent: 신규 insert
    const { data, error } = await this.supabase
      .from('members')
      .insert({
        org_id: input.org_id,
        user_id: null,
        name: input.name,
        type: input.type ?? 'agent',
        avatar_url: input.avatar_url ?? null,
        agent_config: input.agent_config ?? null,
        webhook_url: input.webhook_url ?? null,
        is_active: input.is_active ?? true,
      })
      .select()
      .single();
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as Member;
  }

  async update(id: string, input: UpdateMemberInput): Promise<Member> {
    const ALLOWED: (keyof UpdateMemberInput)[] = ['name', 'avatar_url', 'webhook_url', 'is_active'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) {
      if (key in input) patch[key] = input[key];
    }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');

    const { data, error } = await this.supabase
      .from('members')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as Member;
  }

  async delete(id: string, orgId: string): Promise<void> {
    const { error } = await this.supabase
      .from('members')
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq('id', id)
      .eq('org_id', orgId);
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
  }
}
