import type { SupabaseClient } from '@supabase/supabase-js';
import type { ITaskRepository, Task, CreateTaskInput, UpdateTaskInput, TaskListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { ForbiddenError, NotFoundError } from '@sprintable/core-storage';
import { fastapiCall, mapSupabaseError } from './utils';

export class SupabaseTaskRepository implements ITaskRepository {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly accessToken: string = '',
  ) {}

  private get fastapi(): boolean { return Boolean(this.accessToken); }

  async create(input: CreateTaskInput): Promise<Task> {
    if (this.fastapi) return fastapiCall<Task>('POST', '/api/v2/tasks', this.accessToken, { body: input });
    const { data: story, error: storyError } = await this.supabase.from('stories').select('org_id').eq('id', input.story_id).is('deleted_at', null).single();
    if (storyError) { if (storyError.code === 'PGRST116') throw new NotFoundError('Parent story not found'); throw storyError; }
    const orgId = (story as { org_id: string }).org_id;
    const { data, error } = await this.supabase.from('tasks').insert({ story_id: input.story_id, org_id: orgId, title: input.title.trim(), assignee_id: input.assignee_id ?? null, status: input.status ?? 'todo' }).select().single();
    if (error) { if (error.code === '42501') throw new ForbiddenError('Permission denied'); throw error; }
    return data as Task;
  }

  async list(filters: TaskListFilters): Promise<Task[]> {
    if (this.fastapi) return fastapiCall<Task[]>('GET', '/api/v2/tasks', this.accessToken, {
      query: { story_id: filters.story_id, assignee_id: filters.assignee_id, status: filters.status },
    });
    let query = this.supabase.from('tasks').select('*').is('deleted_at', null).order('created_at', { ascending: false });
    if (filters.story_id) query = query.eq('story_id', filters.story_id);
    if (filters.assignee_id) query = query.eq('assignee_id', filters.assignee_id);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.status_ne) query = query.neq('status', filters.status_ne);
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Task[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Task> {
    if (this.fastapi) return fastapiCall<Task>('GET', `/api/v2/tasks/${id}`, this.accessToken);
    let query = this.supabase.from('tasks').select('*').eq('id', id).is('deleted_at', null);
    if (scope?.org_id) query = query.eq('org_id', scope.org_id);
    const { data, error } = await query.single();
    if (error) throw mapSupabaseError(error);
    return data as Task;
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    if (this.fastapi) return fastapiCall<Task>('PATCH', `/api/v2/tasks/${id}`, this.accessToken, { body: input });
    const ALLOWED: (keyof UpdateTaskInput)[] = ['title', 'status', 'assignee_id'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) { if (key in input) patch[key] = input[key]; }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');
    const { data, error } = await this.supabase.from('tasks').update(patch).eq('id', id).is('deleted_at', null).select().single();
    if (error) throw mapSupabaseError(error);
    return data as Task;
  }

  async delete(id: string, _orgId: string): Promise<void> {
    if (this.fastapi) { await fastapiCall<void>('DELETE', `/api/v2/tasks/${id}`, this.accessToken); return; }
    const { error } = await this.supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) { if (error.code === '42501') throw new ForbiddenError('Permission denied'); throw error; }
  }
}
