import type { PGlite } from '@electric-sql/pglite';
import type { IStoryRepository, Story, CreateStoryInput, UpdateStoryInput, BulkUpdateItem, StoryComment, StoryListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import type { PaginationOptions } from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

export class PgliteStoryRepository implements IStoryRepository {
  constructor(private readonly db: PGlite) {}

  async create(input: CreateStoryInput): Promise<Story> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO stories (id, org_id, project_id, epic_id, sprint_id, assignee_id, title, status, priority, story_points, description, acceptance_criteria, meeting_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, input.org_id, input.project_id, input.epic_id ?? null, input.sprint_id ?? null, input.assignee_id ?? null, input.title.trim(), input.status ?? 'backlog', input.priority ?? 'medium', input.story_points ?? null, input.description ?? null, input.acceptance_criteria ?? null, input.meeting_id ?? null, now, now]));
    return this.getById(id);
  }

  async list(filters: StoryListFilters): Promise<Story[]> {
    let query = 'SELECT * FROM stories WHERE deleted_at IS NULL';
    const params: SqlParam[] = [];
    if (filters.sprint_id) { query += ' AND sprint_id = ?'; params.push(filters.sprint_id); }
    if (filters.epic_id) { query += ' AND epic_id = ?'; params.push(filters.epic_id); }
    if (filters.assignee_id) { query += ' AND assignee_id = ?'; params.push(filters.assignee_id); }
    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.project_id) { query += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.unassigned) { query += ' AND assignee_id IS NULL'; }
    if (filters.q) { query += ' AND title LIKE ?'; params.push(`%${filters.q}%`); }
    if (filters.cursor) { query += ' AND created_at < ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC';
    if (filters.limit) { query += ` LIMIT ${filters.limit + 1}`; }
    return (await this.db.query(...toPos(query, params))).rows as unknown as Story[];
  }

  async backlog(projectId: string): Promise<Story[]> {
    return (await this.db.query(...toPos('SELECT * FROM stories WHERE project_id = ? AND sprint_id IS NULL AND deleted_at IS NULL ORDER BY created_at DESC', [projectId]))).rows as unknown as Story[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Story> {
    let query = 'SELECT * FROM stories WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { query += ' AND org_id = ?'; params.push(scope.org_id); }
    if (scope?.project_id) { query += ' AND project_id = ?'; params.push(scope.project_id); }
    const row = (await this.db.query(...toPos(query, params))).rows[0] as Story | undefined;
    if (!row) throw new NotFoundError('Story not found');
    return row;
  }

  async getByIdWithDetails(id: string, scope?: RepositoryScopeContext): Promise<Story & { tasks: unknown[] }> {
    const story = await this.getById(id, scope);
    const tasks = (await this.db.query(...toPos('SELECT * FROM tasks WHERE story_id = ? ORDER BY created_at ASC', [id]))).rows;
    return { ...story, tasks };
  }

  async update(id: string, input: UpdateStoryInput): Promise<Story> {
    const ALLOWED: (keyof UpdateStoryInput)[] = ['title', 'status', 'priority', 'story_points', 'description', 'acceptance_criteria', 'epic_id', 'sprint_id', 'assignee_id', 'position'];
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const key of ALLOWED) {
      if (key in input) { sets.push(`${key} = ?`); params.push(input[key] as SqlParam); }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    await this.db.query(...toPos(`UPDATE stories SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params));
    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.query(...toPos('UPDATE stories SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), id]));
  }

  async bulkUpdate(items: BulkUpdateItem[]): Promise<Story[]> {
    return Promise.all(items.map(({ id, ...patch }) => this.update(id, patch)));
  }

  async addComment(input: { story_id: string; content: string; created_by: string }): Promise<StoryComment> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos('INSERT INTO story_comments (id, story_id, content, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [id, input.story_id, input.content, input.created_by, now]));
    return (await this.db.query(...toPos('SELECT * FROM story_comments WHERE id = ?', [id]))).rows[0] as unknown as StoryComment;
  }

  async getComments(storyId: string, options?: PaginationOptions): Promise<StoryComment[]> {
    let query = 'SELECT * FROM story_comments WHERE story_id = ?';
    const params: SqlParam[] = [storyId];
    if (options?.cursor) { query += ' AND created_at > ?'; params.push(options.cursor); }
    query += ' ORDER BY created_at ASC';
    if (options?.limit) { query += ` LIMIT ${options.limit}`; }
    return (await this.db.query(...toPos(query, params))).rows as unknown as StoryComment[];
  }

  async getActivities(storyId: string, options?: PaginationOptions): Promise<unknown[]> {
    let query = 'SELECT * FROM story_activities WHERE story_id = ?';
    const params: SqlParam[] = [storyId];
    if (options?.cursor) { query += ' AND created_at < ?'; params.push(options.cursor); }
    query += ' ORDER BY created_at DESC';
    if (options?.limit) { query += ` LIMIT ${options.limit}`; }
    return (await this.db.query(...toPos(query, params))).rows;
  }

  async addActivity(_input: { story_id: string; org_id: string; actor_id: string; action_type: string; old_value?: string | null; new_value?: string | null }): Promise<void> {
    // OSS PGlite mode: activity logs not persisted
  }
}
