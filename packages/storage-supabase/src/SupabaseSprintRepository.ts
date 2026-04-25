import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ISprintRepository,
  Sprint,
  CreateSprintInput,
  UpdateSprintInput,
  SprintListFilters,
  RepositoryScopeContext,
} from '@sprintable/core-storage';
import { ForbiddenError } from '@sprintable/core-storage';
import { mapSupabaseError } from './utils';

export class SupabaseSprintRepository implements ISprintRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateSprintInput): Promise<Sprint> {
    const { data, error } = await this.supabase
      .from('sprints')
      .insert({
        project_id: input.project_id,
        org_id: input.org_id,
        title: input.title.trim(),
        start_date: input.start_date,
        end_date: input.end_date,
        team_size: input.team_size ?? null,
        status: 'planning',
      })
      .select()
      .single();
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as Sprint;
  }

  async list(filters: SprintListFilters): Promise<Sprint[]> {
    let query = this.supabase
      .from('sprints')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (filters.project_id) query = query.eq('project_id', filters.project_id);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Sprint[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Sprint> {
    let query = this.supabase.from('sprints').select('*').eq('id', id).is('deleted_at', null);
    if (scope?.org_id) query = query.eq('org_id', scope.org_id);
    if (scope?.project_id) query = query.eq('project_id', scope.project_id);
    const { data, error } = await query.single();
    if (error) throw mapSupabaseError(error);
    return data as Sprint;
  }

  async update(id: string, input: UpdateSprintInput): Promise<Sprint> {
    const ALLOWED: (keyof UpdateSprintInput)[] = ['title', 'start_date', 'end_date', 'team_size', 'status', 'velocity', 'duration', 'report_doc_id'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) {
      if (key in input) patch[key] = input[key];
    }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');

    const { data, error } = await this.supabase
      .from('sprints')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as Sprint;
  }

  async delete(id: string, orgId: string): Promise<void> {
    const { error } = await this.supabase
      .from('sprints')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('org_id', orgId);
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
  }
}
