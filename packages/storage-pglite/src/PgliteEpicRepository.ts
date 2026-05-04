import type { PGlite } from '@electric-sql/pglite';
import type { IEpicRepository, Epic, CreateEpicInput, UpdateEpicInput, EpicListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

export class PgliteEpicRepository implements IEpicRepository {
  constructor(private readonly db: PGlite) {}

  async create(input: CreateEpicInput): Promise<Epic> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO epics (id, org_id, project_id, title, status, priority, description, objective, success_criteria, target_sp, target_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, input.org_id, input.project_id, input.title.trim(), input.status ?? 'active', input.priority ?? 'medium', input.description ?? null, input.objective ?? null, input.success_criteria ?? null, input.target_sp ?? null, input.target_date ?? null, now, now]));
    return this.getById(id);
  }

  async list(filters: EpicListFilters): Promise<Epic[]> {
    let query = 'SELECT * FROM epics WHERE deleted_at IS NULL';
    const params: SqlParam[] = [];
    if (filters.project_id) { query += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.cursor) { query += ' AND created_at < ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC';
    if (filters.limit) { query += ` LIMIT ${filters.limit + 1}`; }
    return (await this.db.query(...toPos(query, params))).rows as unknown as Epic[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Epic> {
    let query = 'SELECT * FROM epics WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { query += ' AND org_id = ?'; params.push(scope.org_id); }
    if (scope?.project_id) { query += ' AND project_id = ?'; params.push(scope.project_id); }
    const row = (await this.db.query(...toPos(query, params))).rows[0] as Epic | undefined;
    if (!row) throw new NotFoundError('Epic not found');
    return row;
  }

  async getByIdWithStories(id: string, scope?: RepositoryScopeContext): Promise<Epic & { stories: unknown[] }> {
    const epic = await this.getById(id, scope);
    const stories = (await this.db.query(...toPos('SELECT * FROM stories WHERE epic_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', [id]))).rows;
    return { ...epic, stories };
  }

  async update(id: string, input: UpdateEpicInput): Promise<Epic> {
    const ALLOWED: (keyof UpdateEpicInput)[] = ['title', 'status', 'priority', 'description', 'objective', 'success_criteria', 'target_sp', 'target_date'];
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const key of ALLOWED) {
      if (key in input) { sets.push(`${key} = ?`); params.push(input[key] as SqlParam); }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    await this.db.query(...toPos(`UPDATE epics SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params));
    return this.getById(id);
  }

  async delete(id: string, _orgId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(...toPos('UPDATE stories SET epic_id = NULL WHERE epic_id = ?', [id]));
    await this.db.query(...toPos('UPDATE epics SET deleted_at = ? WHERE id = ?', [now, id]));
  }
}
