import type { PGlite } from '@electric-sql/pglite';
import type {
  IDocRepository,
  Doc,
  DocSummary,
  CreateDocInput,
  UpdateDocInput,
  DocListFilters,
  RepositoryScopeContext,
} from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

interface DocRow extends Omit<Doc, 'tags' | 'is_folder'> {
  tags: string | null;
  is_folder: number;
}

function hydrateDoc(row: DocRow): Doc {
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
    is_folder: Boolean(row.is_folder),
  };
}

export class PgliteDocRepository implements IDocRepository {
  constructor(private readonly db: PGlite) {}

  async list(filters: DocListFilters): Promise<DocSummary[]> {
    let query = 'SELECT id, parent_id, title, slug, icon, sort_order, is_folder, updated_at FROM docs WHERE project_id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [filters.project_id];
    if (filters.cursor) { query += ' AND updated_at < ?'; params.push(filters.cursor); }
    query += ' ORDER BY updated_at DESC';
    if (filters.limit != null) { query += ' LIMIT ?'; params.push(filters.limit + 1); }
    const rows = (await this.db.query(...toPos(query, params))).rows as unknown as Array<Omit<DocSummary, 'is_folder'> & { is_folder: number }>;
    return rows.map((r) => ({ ...r, is_folder: Boolean(r.is_folder) }));
  }

  async getTree(projectId: string): Promise<DocSummary[]> {
    const rows = (await this.db.query(...toPos('SELECT id, parent_id, title, slug, icon, sort_order, is_folder, updated_at FROM docs WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order', [projectId]))).rows as unknown as Array<Omit<DocSummary, 'is_folder'> & { is_folder: number }>;
    return rows.map((r) => ({ ...r, is_folder: Boolean(r.is_folder) }));
  }

  async getBySlug(projectId: string, slug: string): Promise<Doc> {
    const row = (await this.db.query(...toPos('SELECT * FROM docs WHERE project_id = ? AND slug = ? AND deleted_at IS NULL', [projectId, slug]))).rows[0] as DocRow | undefined;
    if (!row) throw new NotFoundError('Doc not found');
    return hydrateDoc(row);
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Doc> {
    let query = 'SELECT * FROM docs WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { query += ' AND org_id = ?'; params.push(scope.org_id); }
    if (scope?.project_id) { query += ' AND project_id = ?'; params.push(scope.project_id); }
    const row = (await this.db.query(...toPos(query, params))).rows[0] as DocRow | undefined;
    if (!row) throw new NotFoundError('Doc not found');
    return hydrateDoc(row);
  }

  async create(input: CreateDocInput): Promise<Doc> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO docs (id, org_id, project_id, parent_id, title, slug, content, content_format, icon, tags, sort_order, is_folder, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, input.org_id, input.project_id, input.parent_id ?? null, input.title, input.slug,
      input.content ?? null, input.content_format ?? 'markdown', input.icon ?? null,
      JSON.stringify(input.tags ?? []), input.sort_order ?? 0, input.is_folder ? 1 : 0,
      input.created_by, now, now,
    ]));
    return this.getById(id);
  }

  async update(id: string, input: UpdateDocInput): Promise<Doc> {
    const ALLOWED: (keyof UpdateDocInput)[] = ['title', 'content', 'content_format', 'icon', 'tags', 'sort_order', 'parent_id'];
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const key of ALLOWED) {
      if (key in input) {
        sets.push(`${key} = ?`);
        const val = input[key];
        params.push(key === 'tags' && val != null ? JSON.stringify(val) : (val as SqlParam));
      }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);
    await this.db.query(...toPos(`UPDATE docs SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params));
    return this.getById(id);
  }

  async delete(id: string, _orgId: string): Promise<void> {
    await this.db.query(...toPos('UPDATE docs SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), id]));
  }
}
