import type { PGlite } from '@electric-sql/pglite';
import type {
  ISprintRepository,
  Sprint,
  CreateSprintInput,
  UpdateSprintInput,
  SprintListFilters,
  RepositoryScopeContext,
} from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

export class PgliteSprintRepository implements ISprintRepository {
  constructor(private readonly db: PGlite) {}

  async create(input: CreateSprintInput): Promise<Sprint> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO sprints (id, org_id, project_id, title, status, start_date, end_date, team_size, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?)
    `, [id, input.org_id, input.project_id, input.title.trim(), input.start_date, input.end_date, input.team_size ?? null, now, now]));
    return this.getById(id);
  }

  async list(filters: SprintListFilters): Promise<Sprint[]> {
    let query = 'SELECT * FROM sprints WHERE deleted_at IS NULL';
    const params: SqlParam[] = [];
    if (filters.project_id) { query += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.cursor) { query += ' AND created_at < ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC';
    if (filters.limit != null) { query += ' LIMIT ?'; params.push(filters.limit + 1); }
    return (await this.db.query(...toPos(query, params))).rows as unknown as Sprint[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Sprint> {
    let query = 'SELECT * FROM sprints WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { query += ' AND org_id = ?'; params.push(scope.org_id); }
    if (scope?.project_id) { query += ' AND project_id = ?'; params.push(scope.project_id); }
    const row = (await this.db.query(...toPos(query, params))).rows[0] as Sprint | undefined;
    if (!row) throw new NotFoundError('Sprint not found');
    return row;
  }

  async update(id: string, input: UpdateSprintInput): Promise<Sprint> {
    const ALLOWED: (keyof UpdateSprintInput)[] = ['title', 'start_date', 'end_date', 'team_size', 'status', 'velocity'];
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const key of ALLOWED) {
      if (key in input) { sets.push(`${key} = ?`); params.push(input[key] as SqlParam); }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);
    await this.db.query(...toPos(`UPDATE sprints SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params));
    return this.getById(id);
  }

  async delete(id: string, orgId: string): Promise<void> {
    await this.db.query(...toPos('UPDATE sprints SET deleted_at = ? WHERE id = ? AND org_id = ?', [new Date().toISOString(), id, orgId]));
  }
}
