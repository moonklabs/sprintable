import type { SupabaseClient } from '@supabase/supabase-js';
import type { IEpicRepository, Epic, CreateEpicInput, UpdateEpicInput, EpicListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { ForbiddenError } from '@sprintable/core-storage';
import { mapSupabaseError } from './utils';

export class SupabaseEpicRepository implements IEpicRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateEpicInput): Promise<Epic> {
    const { data, error } = await this.supabase
      .from('epics')
      .insert({
        project_id: input.project_id,
        org_id: input.org_id,
        title: input.title.trim(),
        status: input.status ?? 'draft',
        priority: input.priority ?? 'medium',
        description: input.description ?? null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as Epic;
  }

  async list(filters: EpicListFilters): Promise<Epic[]> {
    let query = this.supabase
      .from('epics')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (filters.project_id) query = query.eq('project_id', filters.project_id);
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Epic[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Epic> {
    let query = this.supabase.from('epics').select('*').eq('id', id).is('deleted_at', null);
    if (scope?.org_id) query = query.eq('org_id', scope.org_id);
    if (scope?.project_id) query = query.eq('project_id', scope.project_id);
    const { data, error } = await query.single();
    if (error) throw mapSupabaseError(error);
    return data as Epic;
  }

  async getByIdWithStories(id: string, scope?: RepositoryScopeContext): Promise<Epic & { stories: unknown[] }> {
    const epic = await this.getById(id, scope);
    const { data: stories } = await this.supabase
      .from('stories')
      .select('*')
      .eq('epic_id', id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    return { ...epic, stories: stories ?? [] };
  }

  async update(id: string, input: UpdateEpicInput): Promise<Epic> {
    const ALLOWED: (keyof UpdateEpicInput)[] = ['title', 'status', 'priority', 'description', 'target_date', 'objective', 'success_criteria', 'target_sp'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) {
      if (key in input) patch[key] = input[key];
    }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');

    await this.getById(id);

    const { data, error } = await this.supabase
      .from('epics')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as Epic;
  }

  async delete(id: string, _orgId: string): Promise<void> {
    const { error: childError } = await this.supabase.from('stories').update({ epic_id: null }).eq('epic_id', id);
    if (childError) throw new Error(`Failed to detach stories: ${childError.message}`);

    const { error } = await this.supabase.from('epics').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
  }
}
