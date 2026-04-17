import type { SupabaseClient } from '@supabase/supabase-js';
import type { ITaskRepository, Task, CreateTaskInput, UpdateTaskInput, TaskListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { ForbiddenError, NotFoundError } from '@sprintable/core-storage';
import { mapSupabaseError } from './utils';

export class SupabaseTaskRepository implements ITaskRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const { data: story, error: storyError } = await this.supabase
      .from('stories')
      .select('org_id')
      .eq('id', input.story_id)
      .is('deleted_at', null)
      .single();
    if (storyError) {
      if (storyError.code === 'PGRST116') throw new NotFoundError('Parent story not found');
      throw storyError;
    }
    const orgId = (story as { org_id: string }).org_id;

    const { data, error } = await this.supabase
      .from('tasks')
      .insert({
        story_id: input.story_id,
        org_id: orgId,
        title: input.title.trim(),
        assignee_id: input.assignee_id ?? null,
        status: input.status ?? 'todo',
        story_points: input.story_points ?? null,
      })
      .select()
      .single();
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as Task;
  }

  async list(filters: TaskListFilters): Promise<Task[]> {
    let query = this.supabase
      .from('tasks')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (filters.story_id) query = query.eq('story_id', filters.story_id);
    if (filters.assignee_id) query = query.eq('assignee_id', filters.assignee_id);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.status_ne) query = query.neq('status', filters.status_ne);
    if (filters.days_since != null) {
      const since = new Date(Date.now() - filters.days_since * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte('created_at', since);
    }
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);

    const { data, error } = await query;
    if (error) throw error;

    let results = (data ?? []) as Task[];
    if (filters.project_id && results.length > 0) {
      const storyIds = [...new Set(results.map((t) => t.story_id))];
      const { data: stories } = await this.supabase
        .from('stories')
        .select('id')
        .eq('project_id', filters.project_id)
        .in('id', storyIds);
      const validStoryIds = new Set((stories ?? []).map((s: { id: string }) => s.id));
      results = results.filter((t) => validStoryIds.has(t.story_id));
    }
    return results;
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Task> {
    let query = this.supabase.from('tasks').select('*').eq('id', id).is('deleted_at', null);
    if (scope?.org_id) query = query.eq('org_id', scope.org_id);
    const { data, error } = await query.single();
    if (error) throw mapSupabaseError(error);
    const task = data as Task;
    if (scope?.project_id) {
      const { data: story } = await this.supabase
        .from('stories').select('project_id').eq('id', task.story_id).single();
      if (!story || (story as { project_id: string }).project_id !== scope.project_id) {
        throw mapSupabaseError({ code: 'PGRST116', message: 'Task not found' });
      }
    }
    return task;
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    const ALLOWED: (keyof UpdateTaskInput)[] = ['title', 'status', 'assignee_id', 'story_points'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) {
      if (key in input) patch[key] = input[key];
    }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');

    await this.getById(id);

    const { data, error } = await this.supabase
      .from('tasks')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as Task;
  }

  async delete(id: string, _orgId: string): Promise<void> {
    const { error } = await this.supabase
      .from('tasks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
  }
}
