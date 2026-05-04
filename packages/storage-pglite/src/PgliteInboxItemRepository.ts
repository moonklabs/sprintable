import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import type {
  IInboxItemRepository,
  InboxItem,
  CreateInboxItemInput,
  InboxListFilters,
  ResolveInboxItemInput,
  DismissInboxItemInput,
  ReassignInboxItemInput,
  InboxItemCount,
  InboxKind,
  OriginNode,
  InboxOption,
} from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

interface InboxItemRow {
  id: string;
  org_id: string;
  project_id: string;
  assignee_member_id: string;
  kind: InboxKind;
  title: string;
  context: string | null;
  agent_summary: string | null;
  origin_chain: string;     // JSON-encoded
  options: string;          // JSON-encoded
  after_decision: string | null;
  from_agent_id: string | null;
  story_id: string | null;
  memo_id: string | null;
  priority: 'high' | 'normal';
  state: 'pending' | 'resolved' | 'dismissed';
  resolved_by: string | null;
  resolved_option_id: string | null;
  resolved_note: string | null;
  source_type: InboxItem['source_type'];
  source_id: string;
  waiting_since: string;
  created_at: string;
  resolved_at: string | null;
}

function hydrate(row: InboxItemRow): InboxItem {
  return {
    ...row,
    origin_chain: parseJsonArray<OriginNode>(row.origin_chain),
    options: parseJsonArray<InboxOption>(row.options),
  };
}

function parseJsonArray<T>(text: string | null | undefined): T[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export class PgliteInboxItemRepository implements IInboxItemRepository {
  constructor(private readonly db: PGlite) {}

  async create(input: CreateInboxItemInput): Promise<InboxItem> {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Idempotency: same (org, source_type, source_id, kind) returns existing row
    const existing = (await this.db.query(...toPos(
      'SELECT * FROM inbox_items WHERE org_id = ? AND source_type = ? AND source_id = ? AND kind = ?',
      [input.org_id, input.source_type, input.source_id, input.kind]
    ))).rows[0] as InboxItemRow | undefined;
    if (existing) return hydrate(existing);

    await this.db.query(...toPos(`
      INSERT INTO inbox_items (
        id, org_id, project_id, assignee_member_id, kind, title, context, agent_summary,
        origin_chain, options, after_decision, from_agent_id, story_id, memo_id,
        priority, state, source_type, source_id, waiting_since, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `, [
      id, input.org_id, input.project_id, input.assignee_member_id, input.kind,
      input.title, input.context ?? null, input.agent_summary ?? null,
      JSON.stringify(input.origin_chain ?? []),
      JSON.stringify(input.options ?? []),
      input.after_decision ?? null, input.from_agent_id ?? null,
      input.story_id ?? null, input.memo_id ?? null,
      input.priority ?? 'normal',
      input.source_type, input.source_id, now, now,
    ]));

    return this.requireById(id, input.org_id);
  }

  async list(filters: InboxListFilters): Promise<InboxItem[]> {
    let query = 'SELECT * FROM inbox_items WHERE org_id = ?';
    const params: SqlParam[] = [filters.org_id];

    if (filters.project_id) { query += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.assignee_member_id) { query += ' AND assignee_member_id = ?'; params.push(filters.assignee_member_id); }
    if (filters.kind) { query += ' AND kind = ?'; params.push(filters.kind); }
    if (filters.state) { query += ' AND state = ?'; params.push(filters.state); }
    if (filters.cursor) { query += ' AND created_at < ?'; params.push(filters.cursor); }

    query += ' ORDER BY created_at DESC';
    if (filters.limit != null) { query += ' LIMIT ?'; params.push(filters.limit); }

    const rows = (await this.db.query(...toPos(query, params))).rows as unknown as InboxItemRow[];
    return rows.map(hydrate);
  }

  async get(id: string, orgId: string): Promise<InboxItem | null> {
    const row = (await this.db.query(...toPos(
      'SELECT * FROM inbox_items WHERE id = ? AND org_id = ?',
      [id, orgId]
    ))).rows[0] as InboxItemRow | undefined;
    return row ? hydrate(row) : null;
  }

  async count(filters: Omit<InboxListFilters, 'limit' | 'cursor'>): Promise<InboxItemCount> {
    let query = 'SELECT kind, COUNT(*) as n FROM inbox_items WHERE org_id = ?';
    const params: SqlParam[] = [filters.org_id];
    if (filters.project_id) { query += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.assignee_member_id) { query += ' AND assignee_member_id = ?'; params.push(filters.assignee_member_id); }
    if (filters.state) { query += ' AND state = ?'; params.push(filters.state); }
    query += ' GROUP BY kind';

    const rows = (await this.db.query(...toPos(query, params))).rows as unknown as Array<{ kind: InboxKind; n: number }>;
    const byKind: Record<InboxKind, number> = { approval: 0, decision: 0, blocker: 0, mention: 0 };
    let total = 0;
    for (const r of rows) {
      byKind[r.kind] = r.n;
      total += r.n;
    }
    return { total, byKind };
  }

  async resolve(id: string, orgId: string, input: ResolveInboxItemInput): Promise<InboxItem> {
    const now = new Date().toISOString();

    await this.db.query('BEGIN');
    try {
      const row = (await this.db.query(...toPos(
        'SELECT * FROM inbox_items WHERE id = ? AND org_id = ?',
        [id, orgId]
      ))).rows[0] as InboxItemRow | undefined;
      if (!row) {
        await this.db.query('ROLLBACK');
        throw new NotFoundError(`Inbox item not found: ${id}`);
      }
      if (row.state !== 'pending') {
        await this.db.query('ROLLBACK');
        throw new Error(`Inbox item already ${row.state}`);
      }

      // Verify resolved_option_id exists in options
      const options = parseJsonArray<InboxOption>(row.options);
      if (!options.some((opt) => opt.id === input.resolved_option_id)) {
        await this.db.query('ROLLBACK');
        throw new Error(`Option id ${input.resolved_option_id} not found in inbox item options`);
      }

      await this.db.query(...toPos(`
        UPDATE inbox_items
        SET state = 'resolved', resolved_by = ?, resolved_option_id = ?, resolved_note = ?, resolved_at = ?
        WHERE id = ? AND org_id = ?
      `, [input.resolved_by, input.resolved_option_id, input.resolved_note ?? null, now, id, orgId]));

      await this.enqueueOutbox(orgId, id, 'resolved', {
        inbox_item_id: id,
        event_type: 'resolved',
        inbox_item_snapshot: {
          title: row.title,
          kind: row.kind,
          project_id: row.project_id,
          org_id: row.org_id,
          options,
          origin_chain: parseJsonArray<OriginNode>(row.origin_chain),
        },
        resolved_choice: input.resolved_option_id,
        resolved_note: input.resolved_note ?? null,
        resolved_by: input.resolved_by,
        ts: now,
      });

      await this.db.query('COMMIT');
    } catch (e) {
      try { await this.db.query('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }

    return this.requireById(id, orgId);
  }

  async dismiss(id: string, orgId: string, input: DismissInboxItemInput): Promise<InboxItem> {
    const now = new Date().toISOString();

    await this.db.query('BEGIN');
    try {
      const row = (await this.db.query(...toPos(
        'SELECT * FROM inbox_items WHERE id = ? AND org_id = ?',
        [id, orgId]
      ))).rows[0] as InboxItemRow | undefined;
      if (!row) {
        await this.db.query('ROLLBACK');
        throw new NotFoundError(`Inbox item not found: ${id}`);
      }
      if (row.state !== 'pending') {
        await this.db.query('ROLLBACK');
        throw new Error(`Inbox item already ${row.state}`);
      }

      await this.db.query(...toPos(`
        UPDATE inbox_items
        SET state = 'dismissed', resolved_by = ?, resolved_note = ?, resolved_at = ?
        WHERE id = ? AND org_id = ?
      `, [input.resolved_by, input.resolved_note ?? null, now, id, orgId]));

      await this.enqueueOutbox(orgId, id, 'dismissed', {
        inbox_item_id: id,
        event_type: 'dismissed',
        inbox_item_snapshot: {
          title: row.title,
          kind: row.kind,
          project_id: row.project_id,
          org_id: row.org_id,
          options: parseJsonArray<InboxOption>(row.options),
          origin_chain: parseJsonArray<OriginNode>(row.origin_chain),
        },
        resolved_note: input.resolved_note ?? null,
        resolved_by: input.resolved_by,
        ts: now,
      });

      await this.db.query('COMMIT');
    } catch (e) {
      try { await this.db.query('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }

    return this.requireById(id, orgId);
  }

  async reassign(id: string, orgId: string, input: ReassignInboxItemInput): Promise<InboxItem> {
    const now = new Date().toISOString();

    await this.db.query('BEGIN');
    try {
      const row = (await this.db.query(...toPos(
        'SELECT * FROM inbox_items WHERE id = ? AND org_id = ?',
        [id, orgId]
      ))).rows[0] as InboxItemRow | undefined;
      if (!row) {
        await this.db.query('ROLLBACK');
        throw new NotFoundError(`Inbox item not found: ${id}`);
      }

      await this.db.query(...toPos(`
        UPDATE inbox_items
        SET assignee_member_id = ?
        WHERE id = ? AND org_id = ?
      `, [input.new_assignee_member_id, id, orgId]));

      await this.enqueueOutbox(orgId, id, 'reassigned', {
        inbox_item_id: id,
        event_type: 'reassigned',
        inbox_item_snapshot: {
          title: row.title,
          kind: row.kind,
          project_id: row.project_id,
          org_id: row.org_id,
          options: parseJsonArray<InboxOption>(row.options),
          origin_chain: parseJsonArray<OriginNode>(row.origin_chain),
        },
        resolved_by: input.reassigned_by,
        ts: now,
      });

      await this.db.query('COMMIT');
    } catch (e) {
      try { await this.db.query('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }

    return this.requireById(id, orgId);
  }

  // ──────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────

  private async requireById(id: string, orgId: string): Promise<InboxItem> {
    const row = (await this.db.query(...toPos(
      'SELECT * FROM inbox_items WHERE id = ? AND org_id = ?',
      [id, orgId]
    ))).rows[0] as InboxItemRow | undefined;
    if (!row) throw new NotFoundError(`Inbox item not found after upsert: ${id}`);
    return hydrate(row);
  }

  private async enqueueOutbox(orgId: string, inboxItemId: string, eventType: 'resolved' | 'dismissed' | 'reassigned', payload: unknown): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO inbox_outbox (
        id, org_id, inbox_item_id, event_type, payload,
        webhook_url, status, attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', 0, ?, ?, ?)
    `, [
      randomUUID(), orgId, inboxItemId, eventType, JSON.stringify(payload),
      now, now, now,
    ]));
  }
}
