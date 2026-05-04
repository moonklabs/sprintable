import type { PGlite } from '@electric-sql/pglite';
import type {
  IProjectRepository,
  Project,
  CreateProjectInput,
  UpdateProjectInput,
  ProjectListFilters,
  RepositoryScopeContext,
} from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

export class PgliteProjectRepository implements IProjectRepository {
  constructor(private readonly db: PGlite) {}

  async list(filters: ProjectListFilters): Promise<Project[]> {
    let query = 'SELECT * FROM projects WHERE org_id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [filters.org_id];
    if (filters.cursor) { query += ' AND created_at > ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at ASC';
    if (filters.limit != null) { query += ' LIMIT ?'; params.push(filters.limit + 1); }
    return (await this.db.query(...toPos(query, params))).rows as unknown as Project[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Project> {
    let query = 'SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { query += ' AND org_id = ?'; params.push(scope.org_id); }
    const row = (await this.db.query(...toPos(query, params))).rows[0] as Project | undefined;
    if (!row) throw new NotFoundError('Project not found');
    return row;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO projects (id, org_id, name, description, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, input.org_id, input.name.trim(), input.description ?? null, input.created_by ?? null, now, now]));
    return this.getById(id);
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    const ALLOWED: (keyof UpdateProjectInput)[] = ['name', 'description'];
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const key of ALLOWED) {
      if (key in input) { sets.push(`${key} = ?`); params.push(input[key] as SqlParam); }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);
    await this.db.query(...toPos(`UPDATE projects SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params));
    return this.getById(id);
  }

  async delete(id: string, orgId: string): Promise<void> {
    await this.db.query(...toPos('UPDATE projects SET deleted_at = ? WHERE id = ? AND org_id = ?', [new Date().toISOString(), id, orgId]));
  }
}
