import type { DatabaseSync } from 'node:sqlite';
import type { ITaskRepository, Task, CreateTaskInput, UpdateTaskInput, TaskListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | bigint | null | Uint8Array;

export class SqliteTaskRepository implements ITaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const story = this.db.prepare('SELECT org_id FROM stories WHERE id = ? AND deleted_at IS NULL').get(input.story_id) as { org_id: string } | undefined;
    if (!story) throw new NotFoundError('Parent story not found');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO tasks (id, org_id, story_id, title, status, assignee_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, story.org_id, input.story_id, input.title.trim(), input.status ?? 'todo', input.assignee_id ?? null, now, now);
    return this.getById(id);
  }

  async list(filters: TaskListFilters): Promise<Task[]> {
    let sql = 'SELECT * FROM tasks WHERE deleted_at IS NULL';
    const params: SqlParam[] = [];
    if (filters.story_id) { sql += ' AND story_id = ?'; params.push(filters.story_id); }
    if (filters.assignee_id) { sql += ' AND assignee_id = ?'; params.push(filters.assignee_id); }
    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters.status_ne) { sql += ' AND status != ?'; params.push(filters.status_ne); }
    if (filters.days_since != null) {
      const since = new Date(Date.now() - filters.days_since * 24 * 60 * 60 * 1000).toISOString();
      sql += ' AND created_at >= ?'; params.push(since);
    }
    if (filters.cursor) { sql += ' AND created_at < ?'; params.push(filters.cursor); }
    sql += ' ORDER BY created_at DESC';
    if (filters.limit != null) { sql += ' LIMIT ?'; params.push(filters.limit + 1); }
    let results = this.db.prepare(sql).all(...params) as unknown as Task[];

    if (filters.project_id && results.length > 0) {
      const storyIds = [...new Set(results.map((t) => t.story_id))];
      const placeholders = storyIds.map(() => '?').join(',');
      const stories = this.db.prepare(`SELECT id FROM stories WHERE project_id = ? AND id IN (${placeholders})`).all(filters.project_id, ...storyIds) as Array<{ id: string }>;
      const validIds = new Set(stories.map((s) => s.id));
      results = results.filter((t) => validIds.has(t.story_id));
    }
    return results;
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Task> {
    let sql = 'SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { sql += ' AND org_id = ?'; params.push(scope.org_id); }
    const row = this.db.prepare(sql).get(...params) as Task | undefined;
    if (!row) throw new NotFoundError('Task not found');
    if (scope?.project_id) {
      const story = this.db.prepare('SELECT project_id FROM stories WHERE id = ?').get(row.story_id) as { project_id: string } | undefined;
      if (!story || story.project_id !== scope.project_id) throw new NotFoundError('Task not found');
    }
    return row;
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    const ALLOWED: (keyof UpdateTaskInput)[] = ['title', 'status', 'assignee_id'];
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const key of ALLOWED) {
      if (key in input) { sets.push(`${key} = ?`); params.push(input[key] as SqlParam); }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
    return this.getById(id);
  }

  async delete(id: string, _orgId: string): Promise<void> {
    this.db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }
}
