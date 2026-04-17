import type { DatabaseSync } from 'node:sqlite';
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

type SqlParam = string | number | bigint | null | Uint8Array;

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

export class SqliteDocRepository implements IDocRepository {
  constructor(private readonly db: DatabaseSync) {}

  async list(filters: DocListFilters): Promise<DocSummary[]> {
    let sql = 'SELECT id, parent_id, title, slug, icon, sort_order, is_folder, updated_at FROM docs WHERE project_id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [filters.project_id];
    if (filters.cursor) { sql += ' AND updated_at < ?'; params.push(filters.cursor); }
    sql += ' ORDER BY updated_at DESC';
    if (filters.limit != null) { sql += ' LIMIT ?'; params.push(filters.limit + 1); }
    const rows = this.db.prepare(sql).all(...params) as unknown as Array<Omit<DocSummary, 'is_folder'> & { is_folder: number }>;
    return rows.map((r) => ({ ...r, is_folder: Boolean(r.is_folder) }));
  }

  async getTree(projectId: string): Promise<DocSummary[]> {
    const rows = this.db.prepare('SELECT id, parent_id, title, slug, icon, sort_order, is_folder, updated_at FROM docs WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order').all(projectId) as unknown as Array<Omit<DocSummary, 'is_folder'> & { is_folder: number }>;
    return rows.map((r) => ({ ...r, is_folder: Boolean(r.is_folder) }));
  }

  async getBySlug(projectId: string, slug: string): Promise<Doc> {
    const row = this.db.prepare('SELECT * FROM docs WHERE project_id = ? AND slug = ? AND deleted_at IS NULL').get(projectId, slug) as DocRow | undefined;
    if (!row) throw new NotFoundError('Doc not found');
    return hydrateDoc(row);
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Doc> {
    let sql = 'SELECT * FROM docs WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { sql += ' AND org_id = ?'; params.push(scope.org_id); }
    if (scope?.project_id) { sql += ' AND project_id = ?'; params.push(scope.project_id); }
    const row = this.db.prepare(sql).get(...params) as DocRow | undefined;
    if (!row) throw new NotFoundError('Doc not found');
    return hydrateDoc(row);
  }

  async create(input: CreateDocInput): Promise<Doc> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO docs (id, org_id, project_id, parent_id, title, slug, content, content_format, icon, tags, sort_order, is_folder, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.org_id, input.project_id, input.parent_id ?? null, input.title, input.slug,
      input.content ?? null, input.content_format ?? 'markdown', input.icon ?? null,
      JSON.stringify(input.tags ?? []), input.sort_order ?? 0, input.is_folder ? 1 : 0,
      input.created_by, now, now,
    );
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
    this.db.prepare(`UPDATE docs SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
    return this.getById(id);
  }

  async delete(id: string, _orgId: string): Promise<void> {
    this.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }
}
