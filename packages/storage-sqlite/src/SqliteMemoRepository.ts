import type { DatabaseSync } from 'node:sqlite';
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

type SqlParam = string | number | bigint | null | Uint8Array;

interface MemoRow extends Omit<Memo, 'metadata'> {
  metadata: string | null;
}

function hydrateMemo(row: MemoRow): Memo {
  return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
}

export class SqliteMemoRepository implements IMemoRepository {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: CreateMemoInput): Promise<Memo> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO memos (id, org_id, project_id, title, content, status, memo_type, assigned_to, supersedes_id, created_by, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.org_id, input.project_id, input.title ?? null, input.content.trim(),
      input.memo_type ?? 'memo', input.assigned_to ?? null, input.supersedes_id ?? null,
      input.created_by, JSON.stringify(input.metadata ?? {}), now, now,
    );
    return this.getById(id);
  }

  async list(filters: MemoListFilters): Promise<Memo[]> {
    let sql = 'SELECT * FROM memos WHERE deleted_at IS NULL';
    const params: SqlParam[] = [];
    if (filters.org_id && !filters.project_id) { sql += ' AND org_id = ?'; params.push(filters.org_id); }
    if (filters.project_id) { sql += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.assigned_to) { sql += ' AND assigned_to = ?'; params.push(filters.assigned_to); }
    if (filters.created_by) { sql += ' AND created_by = ?'; params.push(filters.created_by); }
    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters.q?.trim()) {
      sql += ' AND (title LIKE ? OR content LIKE ?)';
      const q = `%${filters.q.trim()}%`;
      params.push(q, q);
    }
    if (filters.cursor) { sql += ' AND created_at < ?'; params.push(filters.cursor); }
    sql += ' ORDER BY created_at DESC';
    if (filters.limit != null) { sql += ' LIMIT ?'; params.push(filters.limit + 1); }
    const rows = this.db.prepare(sql).all(...params) as unknown as MemoRow[];
    return rows.map(hydrateMemo);
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Memo> {
    let sql = 'SELECT * FROM memos WHERE id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [id];
    if (scope?.org_id) { sql += ' AND org_id = ?'; params.push(scope.org_id); }
    if (scope?.project_id) { sql += ' AND project_id = ?'; params.push(scope.project_id); }
    const row = this.db.prepare(sql).get(...params) as MemoRow | undefined;
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
    this.db.prepare(`UPDATE memos SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
    return this.getById(id);
  }

  async resolve(id: string, resolvedBy: string): Promise<Memo> {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE memos SET status = 'resolved', resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(resolvedBy, now, now, id);
    return this.getById(id);
  }

  async addReply(input: { memo_id: string; content: string; created_by: string; review_type?: string }): Promise<MemoReply> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO memo_replies (id, memo_id, content, created_by, review_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.memo_id, input.content.trim(), input.created_by, input.review_type ?? 'comment', now);
    return this.db.prepare('SELECT * FROM memo_replies WHERE id = ?').get(id) as unknown as MemoReply;
  }

  async getReplies(memoId: string): Promise<MemoReply[]> {
    return this.db.prepare('SELECT * FROM memo_replies WHERE memo_id = ? ORDER BY created_at ASC').all(memoId) as unknown as MemoReply[];
  }
}
