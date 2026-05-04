import type { PGlite } from '@electric-sql/pglite';
import type { ITaskRepository, Task, CreateTaskInput, UpdateTaskInput, TaskListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

export class PgliteTaskRepository implements ITaskRepository {
  constructor(private readonly db: PGlite) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const story = (await this.db.query(...toPos('SELECT org_id FROM stories WHERE id = ? AND deleted_at IS NULL', [input.story_id]))).rows[0] as { org_id: string } | undefined;
    if (!story) throw new NotFoundError('Parent story not found');
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO tasks (id, org_id, story_id, title, status, assignee_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, story.org_id, input.story_id, input.title.trim(), input.status ?? 'todo', input.assignee_id ?? null, now, now]));
    return this.getById(id);
  }

  async list(filters: TaskListFilters): Promise<Task[]> {
    let query = 'SELECT * FROM tasks WHERE deleted_at IS NULL';
    const params: SqlParam[] = [];
    if (filters.story_id) { query += ' AND story_id = ?'; params.push(filters.story_id); }
    if (filters.assignee_id) { query += ' AND assignee_id = ?'; params.push(filters.assignee_id); }
    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.status_ne) { query += ' AND status != ?'; params.push(filters.status_ne); }
    if (filters.days_since != null) {
      const since = new Date(Date.now() - filters.days_since * 24 * 60 * 60 * 1000).toISOString();
      query += ' AND created_at >= ?'; params.push(since);
    }
    if (filters.cursor) { query += ' AND created_at < ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC';
    if (filters.limit != null) { query += ' LIMIT ?'; params.push(filters.limit + 1); }
    let results = (await this.db.query(...toPos(query, params))).rows as unknown as Task[];

    if (filters.project_id && results.length > 0) {
      const storyIds = [...new Set(results.map((t) => t.story_id))];
      const placeholders = storyIds.map(() => '?').join(',');
      const stories = (await this.db.query(...toPos(`SELECT id FROM stories WHERE project_id = ? AND id IN (${placeholders})`, [filters.project_id, ...storyIds]))).rows as Array<{ id: string }>;
      const validIds = new Set(stories.map((s) => s.id));
      results = results.filter((t) => validIds.has(t.story_id));
    }
    return results;
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Task> {
    let query = 'SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { query += ' AND org_id = ?'; params.push(scope.org_id); }
    const row = (await this.db.query(...toPos(query, params))).rows[0] as Task | undefined;
    if (!row) throw new NotFoundError('Task not found');
    if (scope?.project_id) {
      const story = (await this.db.query(...toPos('SELECT project_id FROM stories WHERE id = ?', [row.story_id]))).rows[0] as { project_id: string } | undefined;
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
    await this.db.query(...toPos(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params));
    return this.getById(id);
  }

  async delete(id: string, _orgId: string): Promise<void> {
    await this.db.query(...toPos('UPDATE tasks SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), id]));
  }
}
