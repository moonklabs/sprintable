import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  IProjectRepository,
  Project,
  CreateProjectInput,
  UpdateProjectInput,
  ProjectListFilters,
  RepositoryScopeContext,
} from '@sprintable/core-storage';
import { ForbiddenError } from '@sprintable/core-storage';
import { mapSupabaseError } from './utils';

export class SupabaseProjectRepository implements IProjectRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(filters: ProjectListFilters): Promise<Project[]> {
    let query = this.supabase
      .from('projects')
      .select('*')
      .eq('org_id', filters.org_id)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (filters.cursor) query = query.gt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Project[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Project> {
    let query = this.supabase.from('projects').select('*').eq('id', id).is('deleted_at', null);
    if (scope?.org_id) query = query.eq('org_id', scope.org_id);
    const { data, error } = await query.single();
    if (error) throw mapSupabaseError(error);
    return data as Project;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const { data, error } = await this.supabase
      .from('projects')
      .insert({
        org_id: input.org_id,
        name: input.name.trim(),
        description: input.description ?? null,
        created_by: input.created_by ?? null,
      })
      .select()
      .single();
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as Project;
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    const ALLOWED: (keyof UpdateProjectInput)[] = ['name', 'description'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) {
      if (key in input) patch[key] = input[key];
    }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');

    const { data, error } = await this.supabase
      .from('projects')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as Project;
  }

  async delete(id: string, orgId: string): Promise<void> {
    const { error } = await this.supabase
      .from('projects')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('org_id', orgId);
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
  }
}
