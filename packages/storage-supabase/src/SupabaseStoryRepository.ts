import type { SupabaseClient } from '@supabase/supabase-js';
import type { IStoryRepository, Story, CreateStoryInput, UpdateStoryInput, BulkUpdateItem, StoryComment, StoryListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import type { PaginationOptions } from '@sprintable/core-storage';
import { mapSupabaseError } from './utils';

export class SupabaseStoryRepository implements IStoryRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateStoryInput): Promise<Story> {
    const { data, error } = await this.supabase
      .from('stories')
      .insert({
        project_id: input.project_id,
        org_id: input.org_id,
        title: input.title.trim(),
        epic_id: input.epic_id ?? null,
        sprint_id: input.sprint_id ?? null,
        assignee_id: input.assignee_id ?? null,
        status: input.status ?? 'backlog',
        priority: input.priority ?? 'medium',
        story_points: input.story_points ?? null,
        description: input.description ?? null,
        meeting_id: input.meeting_id ?? null,
      })
      .select()
      .single();

    if (error) throw mapSupabaseError(error);
    return data as Story;
  }

  async list(filters: StoryListFilters): Promise<Story[]> {
    let query = this.supabase
      .from('stories')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (filters.sprint_id) query = query.eq('sprint_id', filters.sprint_id);
    if (filters.epic_id) query = query.eq('epic_id', filters.epic_id);
    if (filters.assignee_id) query = query.eq('assignee_id', filters.assignee_id);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.project_id) query = query.eq('project_id', filters.project_id);
    if (filters.unassigned) query = query.is('assignee_id', null);
    if (filters.q) query = query.ilike('title', `%${filters.q}%`);
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Story[];
  }

  async backlog(projectId: string): Promise<Story[]> {
    const { data, error } = await this.supabase
      .from('stories')
      .select('*')
      .eq('project_id', projectId)
      .is('sprint_id', null)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Story[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Story> {
    let query = this.supabase.from('stories').select('*').eq('id', id).is('deleted_at', null);
    if (scope?.org_id) query = query.eq('org_id', scope.org_id);
    if (scope?.project_id) query = query.eq('project_id', scope.project_id);
    const { data, error } = await query.single();
    if (error) throw mapSupabaseError(error);
    return data as Story;
  }

  async getByIdWithDetails(id: string, scope?: RepositoryScopeContext): Promise<Story & { tasks: unknown[] }> {
    const story = await this.getById(id, scope);
    const { data: tasks } = await this.supabase
      .from('tasks')
      .select('*')
      .eq('story_id', id)
      .order('created_at', { ascending: true });
    return { ...story, tasks: tasks ?? [] };
  }

  async update(id: string, input: UpdateStoryInput): Promise<Story> {
    const ALLOWED: (keyof UpdateStoryInput)[] = ['title', 'status', 'priority', 'story_points', 'description', 'epic_id', 'sprint_id', 'assignee_id'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) {
      if (key in input) patch[key] = input[key];
    }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');

    const { data, error } = await this.supabase
      .from('stories')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as Story;
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.supabase.from('stories').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) throw mapSupabaseError(error);
  }

  async bulkUpdate(items: BulkUpdateItem[]): Promise<Story[]> {
    const results = await Promise.all(items.map((item) => {
      const { id, ...patch } = item;
      return this.update(id, patch);
    }));
    return results;
  }

  async addComment(input: { story_id: string; content: string; created_by: string }): Promise<StoryComment> {
    const { data, error } = await this.supabase.from('story_comments').insert(input).select().single();
    if (error) throw mapSupabaseError(error);
    return data as StoryComment;
  }

  async getComments(storyId: string, options?: PaginationOptions): Promise<StoryComment[]> {
    let query = this.supabase.from('story_comments').select('*').eq('story_id', storyId).order('created_at', { ascending: true });
    if (options?.cursor) query = query.gt('created_at', options.cursor);
    if (options?.limit) query = query.limit(options.limit);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as StoryComment[];
  }

  async getActivities(storyId: string, options?: PaginationOptions): Promise<unknown[]> {
    let query = this.supabase.from('story_activities').select('*').eq('story_id', storyId).order('created_at', { ascending: false });
    if (options?.cursor) query = query.lt('created_at', options.cursor);
    if (options?.limit) query = query.limit(options.limit);
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }
}
