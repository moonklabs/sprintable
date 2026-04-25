import type { DatabaseSync } from 'node:sqlite';
import type { IStoryRepository, Story, CreateStoryInput, UpdateStoryInput, BulkUpdateItem, StoryComment, StoryListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import type { PaginationOptions } from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | bigint | null | Uint8Array;

export class SqliteStoryRepository implements IStoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: CreateStoryInput): Promise<Story> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO stories (id, org_id, project_id, epic_id, sprint_id, assignee_id, title, status, priority, story_points, description, acceptance_criteria, meeting_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.org_id, input.project_id, input.epic_id ?? null, input.sprint_id ?? null, input.assignee_id ?? null, input.title.trim(), input.status ?? 'backlog', input.priority ?? 'medium', input.story_points ?? null, input.description ?? null, input.acceptance_criteria ?? null, input.meeting_id ?? null, now, now);
    return this.getById(id);
  }

  async list(filters: StoryListFilters): Promise<Story[]> {
    let sql = 'SELECT * FROM stories WHERE deleted_at IS NULL';
    const params: SqlParam[] = [];
    if (filters.sprint_id) { sql += ' AND sprint_id = ?'; params.push(filters.sprint_id); }
    if (filters.epic_id) { sql += ' AND epic_id = ?'; params.push(filters.epic_id); }
    if (filters.assignee_id) { sql += ' AND assignee_id = ?'; params.push(filters.assignee_id); }
    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters.project_id) { sql += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.unassigned) { sql += ' AND assignee_id IS NULL'; }
    if (filters.q) { sql += ' AND title LIKE ?'; params.push(`%${filters.q}%`); }
    if (filters.cursor) { sql += ' AND created_at < ?'; params.push(filters.cursor); }
    sql += ' ORDER BY created_at DESC';
    if (filters.limit) { sql += ` LIMIT ${filters.limit + 1}`; }
    return this.db.prepare(sql).all(...params) as unknown as Story[];
  }

  async backlog(projectId: string): Promise<Story[]> {
    return this.db.prepare('SELECT * FROM stories WHERE project_id = ? AND sprint_id IS NULL AND deleted_at IS NULL ORDER BY created_at DESC').all(projectId) as unknown as Story[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Story> {
    let sql = 'SELECT * FROM stories WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { sql += ' AND org_id = ?'; params.push(scope.org_id); }
    if (scope?.project_id) { sql += ' AND project_id = ?'; params.push(scope.project_id); }
    const row = this.db.prepare(sql).get(...params) as Story | undefined;
    if (!row) throw new NotFoundError('Story not found');
    return row;
  }

  async getByIdWithDetails(id: string, scope?: RepositoryScopeContext): Promise<Story & { tasks: unknown[] }> {
    const story = await this.getById(id, scope);
    const tasks = this.db.prepare('SELECT * FROM tasks WHERE story_id = ? ORDER BY created_at ASC').all(id);
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
    this.db.prepare(`UPDATE stories SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('UPDATE stories SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  async bulkUpdate(items: BulkUpdateItem[]): Promise<Story[]> {
    return Promise.all(items.map(({ id, ...patch }) => this.update(id, patch)));
  }

  async addComment(input: { story_id: string; content: string; created_by: string }): Promise<StoryComment> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO story_comments (id, story_id, content, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, input.story_id, input.content, input.created_by, now);
    return this.db.prepare('SELECT * FROM story_comments WHERE id = ?').get(id) as unknown as StoryComment;
  }

  async getComments(storyId: string, options?: PaginationOptions): Promise<StoryComment[]> {
    let sql = 'SELECT * FROM story_comments WHERE story_id = ?';
    const params: SqlParam[] = [storyId];
    if (options?.cursor) { sql += ' AND created_at > ?'; params.push(options.cursor); }
    sql += ' ORDER BY created_at ASC';
    if (options?.limit) { sql += ` LIMIT ${options.limit}`; }
    return this.db.prepare(sql).all(...params) as unknown as StoryComment[];
  }

  async getActivities(storyId: string, options?: PaginationOptions): Promise<unknown[]> {
    let sql = 'SELECT * FROM story_activities WHERE story_id = ?';
    const params: SqlParam[] = [storyId];
    if (options?.cursor) { sql += ' AND created_at < ?'; params.push(options.cursor); }
    sql += ' ORDER BY created_at DESC';
    if (options?.limit) { sql += ` LIMIT ${options.limit}`; }
    return this.db.prepare(sql).all(...params);
  }

  async addActivity(_input: { story_id: string; org_id: string; actor_id: string; action_type: string; old_value?: string | null; new_value?: string | null }): Promise<void> {
    // OSS SQLite mode: activity logs not persisted
  }
}
