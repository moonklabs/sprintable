import type { PaginationOptions } from '../types';
import type { RepositoryScopeContext } from './IEpicRepository';

export interface Story {
  id: string;
  org_id: string;
  project_id: string;
  epic_id: string | null;
  sprint_id: string | null;
  assignee_id: string | null;
  title: string;
  status: string;
  priority: string;
  story_points: number | null;
  description: string | null;
  acceptance_criteria: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateStoryInput {
  project_id: string;
  org_id: string;
  title: string;
  epic_id?: string | null;
  sprint_id?: string | null;
  assignee_id?: string | null;
  status?: string;
  priority?: string;
  story_points?: number | null;
  description?: string | null;
  acceptance_criteria?: string | null;
  meeting_id?: string | null;
}

export interface UpdateStoryInput {
  title?: string;
  status?: string;
  priority?: string;
  story_points?: number | null;
  description?: string | null;
  acceptance_criteria?: string | null;
  epic_id?: string | null;
  sprint_id?: string | null;
  assignee_id?: string | null;
}

export interface BulkUpdateItem {
  id: string;
  status?: string;
  sprint_id?: string | null;
  assignee_id?: string | null;
}

export interface StoryComment {
  id: string;
  story_id: string;
  content: string;
  created_by: string;
  created_at: string;
}

export interface StoryListFilters extends PaginationOptions {
  sprint_id?: string;
  epic_id?: string;
  assignee_id?: string;
  status?: string;
  project_id?: string;
  q?: string;
  unassigned?: boolean;
}

export interface IStoryRepository {
  create(input: CreateStoryInput): Promise<Story>;
  list(filters: StoryListFilters): Promise<Story[]>;
  backlog(projectId: string): Promise<Story[]>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Story>;
  getByIdWithDetails(id: string, scope?: RepositoryScopeContext): Promise<Story & { tasks: unknown[] }>;
  update(id: string, input: UpdateStoryInput): Promise<Story>;
  delete(id: string): Promise<void>;
  bulkUpdate(items: BulkUpdateItem[]): Promise<Story[]>;
  addComment(input: { story_id: string; content: string; created_by: string }): Promise<StoryComment>;
  getComments(storyId: string, options?: PaginationOptions): Promise<StoryComment[]>;
  getActivities(storyId: string, options?: PaginationOptions): Promise<unknown[]>;
}
