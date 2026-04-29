import type { SupabaseClient } from '@supabase/supabase-js';

export interface Member {
  id: string;
  org_id: string;
  user_id: string | null;
  name: string;
  type: 'human' | 'agent';
  avatar_url?: string | null;
  agent_config?: Record<string, unknown> | null;
  webhook_url?: string | null;
  is_active: boolean;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertMemberInput {
  org_id: string;
  user_id?: string | null;
  name: string;
  type: 'human' | 'agent';
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

export class SupabaseMemberRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(filters: { org_id: string; type?: 'human' | 'agent'; is_active?: boolean }): Promise<Member[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (this.supabase as any)
      .from('members')
      .select('*')
      .eq('org_id', filters.org_id)
      .order('created_at', { ascending: true });

    if (filters.type !== undefined) query = query.eq('type', filters.type);
    if (filters.is_active !== undefined) query = query.eq('is_active', filters.is_active);

    const { data, error } = await query;
    if (error || !data) return [];
    return data as Member[];
  }

  async getById(id: string): Promise<Member | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (this.supabase as any)
      .from('members')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    return (data as Member | null) ?? null;
  }

  async getByUserId(userId: string, orgId: string, type?: string): Promise<Member | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (this.supabase as any)
      .from('members')
      .select('*')
      .eq('user_id', userId)
      .eq('org_id', orgId);
    if (type) query = query.eq('type', type);
    const { data } = await query.maybeSingle();
    return (data as Member | null) ?? null;
  }

  async upsertHuman(input: UpsertMemberInput & { user_id: string }): Promise<Member | null> {
    // Partial unique index (WHERE type = 'human') cannot be used as ON CONFLICT target via JS client.
    // Use explicit select → update/insert pattern with type='human' filter to prevent multi-row
    // error when the same (user_id, org_id) exists as both human and agent records.
    const existing = await this.getByUserId(input.user_id, input.org_id, 'human');

    if (existing) {
      return this.update(existing.id, {
        name: input.name,
        avatar_url: input.avatar_url,
        is_active: input.is_active ?? true,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any)
      .from('members')
      .insert({
        org_id: input.org_id,
        user_id: input.user_id,
        name: input.name,
        type: 'human',
        avatar_url: input.avatar_url ?? null,
        is_active: input.is_active ?? true,
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single();
    if (error) return null;
    return data as Member;
  }

  async insertAgent(input: UpsertMemberInput): Promise<Member | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any)
      .from('members')
      .insert({
        org_id: input.org_id,
        user_id: input.user_id ?? null,
        name: input.name,
        type: 'agent',
        agent_config: input.agent_config ?? null,
        webhook_url: input.webhook_url ?? null,
        is_active: input.is_active ?? true,
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single();
    if (error) return null;
    return data as Member;
  }

  async update(id: string, input: UpdateMemberInput): Promise<Member | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any)
      .from('members')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) return null;
    return data as Member;
  }

  async softDelete(id: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (this.supabase as any)
      .from('members')
      .update({
        is_active: false,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    return !error;
  }
}
