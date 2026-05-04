import type { PGlite } from '@electric-sql/pglite';
import type {
  IMemoRepository,
  Memo,
  CreateMemoInput,
  UpdateMemoInput,
  MemoReply,
  MemoListFilters,
  RepositoryScopeContext,
} from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

interface MemoRow extends Omit<Memo, 'metadata'> {
  metadata: string | null;
}

function hydrateMemo(row: MemoRow): Memo {
  return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
}

export class PgliteMemoRepository implements IMemoRepository {
  constructor(private readonly db: PGlite) {}

  async create(input: CreateMemoInput): Promise<Memo> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO memos (id, org_id, project_id, title, content, status, memo_type, assigned_to, supersedes_id, created_by, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, input.org_id, input.project_id, input.title ?? null, input.content.trim(),
      input.memo_type ?? 'memo', input.assigned_to ?? null, input.supersedes_id ?? null,
      input.created_by, JSON.stringify(input.metadata ?? {}), now, now,
    ]));
    return this.getById(id);
  }

  async list(filters: MemoListFilters): Promise<Memo[]> {
    let query = 'SELECT * FROM memos WHERE deleted_at IS NULL';
    const params: SqlParam[] = [];
    if (filters.org_id && !filters.project_id) { query += ' AND org_id = ?'; params.push(filters.org_id); }
    if (filters.project_id) { query += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.assigned_to) { query += ' AND assigned_to = ?'; params.push(filters.assigned_to); }
    if (filters.created_by) { query += ' AND created_by = ?'; params.push(filters.created_by); }
    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.q?.trim()) {
      query += ' AND (title LIKE ? OR content LIKE ?)';
      const q = `%${filters.q.trim()}%`;
      params.push(q, q);
    }
    if (filters.cursor) { query += ' AND created_at < ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC';
    if (filters.limit != null) { query += ' LIMIT ?'; params.push(filters.limit + 1); }
    const rows = (await this.db.query(...toPos(query, params))).rows as unknown as MemoRow[];
    return rows.map(hydrateMemo);
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Memo> {
    let query = 'SELECT * FROM memos WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { query += ' AND org_id = ?'; params.push(scope.org_id); }
    if (scope?.project_id) { query += ' AND project_id = ?'; params.push(scope.project_id); }
    const row = (await this.db.query(...toPos(query, params))).rows[0] as MemoRow | undefined;
    if (!row) throw new NotFoundError('Memo not found');
    return hydrateMemo(row);
  }

  async update(id: string, input: UpdateMemoInput): Promise<Memo> {
    const ALLOWED: (keyof UpdateMemoInput)[] = ['title', 'content', 'status', 'assigned_to', 'metadata'];
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const key of ALLOWED) {
      if (key in input) {
        sets.push(`${key} = ?`);
        const val = input[key];
        params.push(key === 'metadata' && val != null ? JSON.stringify(val) : (val as SqlParam));
      }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);
    await this.db.query(...toPos(`UPDATE memos SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params));
    return this.getById(id);
  }

  async resolve(id: string, resolvedBy: string): Promise<Memo> {
    const now = new Date().toISOString();
    await this.db.query(...toPos(`UPDATE memos SET status = 'resolved', resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [resolvedBy, now, now, id]));
    return this.getById(id);
  }

  async archive(id: string, archivedAt: string | null): Promise<Memo> {
    const now = new Date().toISOString();
    await this.db.query(...toPos('UPDATE memos SET archived_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [archivedAt, now, id]));
    return this.getById(id);
  }

  async addReply(input: { memo_id: string; content: string; created_by: string; review_type?: string }): Promise<MemoReply> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO memo_replies (id, memo_id, content, created_by, review_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, input.memo_id, input.content.trim(), input.created_by, input.review_type ?? 'comment', now]));
    return (await this.db.query(...toPos('SELECT * FROM memo_replies WHERE id = ?', [id]))).rows[0] as unknown as MemoReply;
  }

  async getReplies(memoId: string): Promise<MemoReply[]> {
    return (await this.db.query(...toPos('SELECT * FROM memo_replies WHERE memo_id = ? ORDER BY created_at ASC', [memoId]))).rows as unknown as MemoReply[];
  }
}
