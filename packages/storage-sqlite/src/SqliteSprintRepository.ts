import type { DatabaseSync } from 'node:sqlite';
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

type SqlParam = string | number | bigint | null | Uint8Array;

export class SqliteSprintRepository implements ISprintRepository {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: CreateSprintInput): Promise<Sprint> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sprints (id, org_id, project_id, title, status, start_date, end_date, team_size, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?)
    `).run(id, input.org_id, input.project_id, input.title.trim(), input.start_date, input.end_date, input.team_size ?? null, now, now);
    return this.getById(id);
  }

  async list(filters: SprintListFilters): Promise<Sprint[]> {
    let sql = 'SELECT * FROM sprints WHERE deleted_at IS NULL';
    const params: SqlParam[] = [];
    if (filters.project_id) { sql += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters.cursor) { sql += ' AND created_at < ?'; params.push(filters.cursor); }
    sql += ' ORDER BY created_at DESC';
    if (filters.limit != null) { sql += ' LIMIT ?'; params.push(filters.limit + 1); }
    return this.db.prepare(sql).all(...params) as unknown as Sprint[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Sprint> {
    let sql = 'SELECT * FROM sprints WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { sql += ' AND org_id = ?'; params.push(scope.org_id); }
    if (scope?.project_id) { sql += ' AND project_id = ?'; params.push(scope.project_id); }
    const row = this.db.prepare(sql).get(...params) as Sprint | undefined;
    if (!row) throw new NotFoundError('Sprint not found');
    return row;
  }

  async update(id: string, input: UpdateSprintInput): Promise<Sprint> {
    const ALLOWED: (keyof UpdateSprintInput)[] = ['title', 'start_date', 'end_date', 'team_size', 'status'];
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const key of ALLOWED) {
      if (key in input) { sets.push(`${key} = ?`); params.push(input[key] as SqlParam); }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE sprints SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
    return this.getById(id);
  }

  async delete(id: string, orgId: string): Promise<void> {
    this.db.prepare('UPDATE sprints SET deleted_at = ? WHERE id = ? AND org_id = ?').run(new Date().toISOString(), id, orgId);
  }
}
