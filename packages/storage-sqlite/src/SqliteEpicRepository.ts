import type { DatabaseSync } from 'node:sqlite';
import type { IEpicRepository, Epic, CreateEpicInput, UpdateEpicInput, EpicListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | bigint | null | Uint8Array;

export class SqliteEpicRepository implements IEpicRepository {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: CreateEpicInput): Promise<Epic> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO epics (id, org_id, project_id, title, status, priority, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.org_id, input.project_id, input.title.trim(), input.status ?? 'open', input.priority ?? 'medium', input.description ?? null, now, now);
    return this.getById(id);
  }

  async list(filters: EpicListFilters): Promise<Epic[]> {
    let sql = 'SELECT * FROM epics WHERE deleted_at IS NULL';
    const params: SqlParam[] = [];
    if (filters.project_id) { sql += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.cursor) { sql += ' AND created_at < ?'; params.push(filters.cursor); }
    sql += ' ORDER BY created_at DESC';
    if (filters.limit) { sql += ` LIMIT ${filters.limit + 1}`; }
    return this.db.prepare(sql).all(...params) as unknown as Epic[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Epic> {
    let sql = 'SELECT * FROM epics WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { sql += ' AND org_id = ?'; params.push(scope.org_id); }
    if (scope?.project_id) { sql += ' AND project_id = ?'; params.push(scope.project_id); }
    const row = this.db.prepare(sql).get(...params) as Epic | undefined;
    if (!row) throw new NotFoundError('Epic not found');
    return row;
  }

  async getByIdWithStories(id: string, scope?: RepositoryScopeContext): Promise<Epic & { stories: unknown[] }> {
    const epic = await this.getById(id, scope);
    const stories = this.db.prepare('SELECT * FROM stories WHERE epic_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(id);
    return { ...epic, stories };
  }

  async update(id: string, input: UpdateEpicInput): Promise<Epic> {
    const ALLOWED: (keyof UpdateEpicInput)[] = ['title', 'status', 'priority', 'description'];
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const key of ALLOWED) {
      if (key in input) { sets.push(`${key} = ?`); params.push(input[key] as SqlParam); }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE epics SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
    return this.getById(id);
  }

  async delete(id: string, _orgId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE stories SET epic_id = NULL WHERE epic_id = ?').run(id);
    this.db.prepare('UPDATE epics SET deleted_at = ? WHERE id = ?').run(now, id);
  }
}
