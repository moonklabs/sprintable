import type { SupabaseClient } from '@supabase/supabase-js';
import { fastapiCall } from '@sprintable/storage-supabase';

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
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly accessToken: string = '',
  ) {}

  private get fastapi(): boolean { return Boolean(this.accessToken); }

  async list(filters: { org_id: string; type?: 'human' | 'agent'; is_active?: boolean }): Promise<Member[]> {
    if (this.fastapi) {
      return fastapiCall<Member[]>('GET', '/api/v2/org-members', this.accessToken, {
        query: { type: filters.type, is_active: filters.is_active != null ? String(filters.is_active) : undefined },
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (this.supabase as any).from('members').select('*').eq('org_id', filters.org_id).order('created_at', { ascending: true });
    if (filters.type !== undefined) query = query.eq('type', filters.type);
    if (filters.is_active !== undefined) query = query.eq('is_active', filters.is_active);
    const { data, error } = await query;
    if (error || !data) return [];
    return data as Member[];
  }

  async getById(id: string): Promise<Member | null> {
    if (this.fastapi) {
      try { return await fastapiCall<Member>('GET', `/api/v2/org-members/${id}`, this.accessToken); }
      catch { return null; }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (this.supabase as any).from('members').select('*').eq('id', id).maybeSingle();
    return (data as Member | null) ?? null;
  }

  async getByUserId(userId: string, orgId: string, type?: string): Promise<Member | null> {
    if (this.fastapi) {
      try {
        const members = await fastapiCall<Member[]>('GET', '/api/v2/org-members', this.accessToken, { query: { type } });
        return members.find((m) => (m as unknown as { user_id?: string }).user_id === userId) ?? null;
      } catch { return null; }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (this.supabase as any).from('members').select('*').eq('user_id', userId).eq('org_id', orgId);
    if (type) query = query.eq('type', type);
    const { data } = await query.maybeSingle();
    return (data as Member | null) ?? null;
  }

  async upsertHuman(input: UpsertMemberInput & { user_id: string }): Promise<Member | null> {
    if (this.fastapi) {
      return fastapiCall<Member>('POST', '/api/v2/org-members/upsert', this.accessToken, { body: { ...input, type: 'human' } });
    }
    const existing = await this.getByUserId(input.user_id, input.org_id, 'human');
    if (existing) return this.update(existing.id, { name: input.name, avatar_url: input.avatar_url, is_active: input.is_active ?? true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).from('members').insert({ org_id: input.org_id, user_id: input.user_id, name: input.name, type: 'human', avatar_url: input.avatar_url ?? null, is_active: input.is_active ?? true, updated_at: new Date().toISOString() }).select('*').single();
    if (error) return null;
    return data as Member;
  }

  async insertAgent(input: UpsertMemberInput): Promise<Member | null> {
    if (this.fastapi) {
      return fastapiCall<Member>('POST', '/api/v2/org-members', this.accessToken, { body: { ...input, type: 'agent' } });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).from('members').insert({ org_id: input.org_id, user_id: input.user_id ?? null, name: input.name, type: 'agent', agent_config: input.agent_config ?? null, webhook_url: input.webhook_url ?? null, is_active: input.is_active ?? true, updated_at: new Date().toISOString() }).select('*').single();
    if (error) return null;
    return data as Member;
  }

  async update(id: string, input: UpdateMemberInput): Promise<Member | null> {
    if (this.fastapi) {
      return fastapiCall<Member>('PATCH', `/api/v2/org-members/${id}`, this.accessToken, { body: input });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).from('members').update({ ...input, updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
    if (error) return null;
    return data as Member;
  }

  async softDelete(id: string): Promise<boolean> {
    if (this.fastapi) {
      try { await fastapiCall<void>('DELETE', `/api/v2/org-members/${id}`, this.accessToken); return true; }
      catch { return false; }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (this.supabase as any).from('members').update({ is_active: false, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
    return !error;
  }
}
