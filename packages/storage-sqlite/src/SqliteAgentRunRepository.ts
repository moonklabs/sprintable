import type { DatabaseSync } from 'node:sqlite';
import type {
  IAgentRunRepository,
  AgentRun,
  AgentRunListFilters,
  AgentRunListResult,
} from '@sprintable/core-storage';

type SqlParam = string | number | bigint | null | Uint8Array;

export class SqliteAgentRunRepository implements IAgentRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  async list(filters: AgentRunListFilters): Promise<AgentRunListResult> {
    let sql = 'SELECT * FROM agent_runs WHERE org_id = ? AND project_id = ?';
    const params: SqlParam[] = [filters.orgId, filters.projectId];

    if (filters.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }

    const fromDate = filters.from ?? new Date(Date.now() - 7 * 86400000).toISOString();
    sql += ' AND created_at >= ?';
    params.push(fromDate);

    if (filters.to) {
      sql += ' AND created_at <= ?';
      params.push(filters.to);
    }

    if (filters.cursor) {
      sql += ' AND created_at < ?';
      params.push(filters.cursor);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(filters.limit + 1);

    const rows = this.db.prepare(sql).all(...params) as unknown as AgentRun[];
    const hasMore = rows.length > filters.limit;
    const items = hasMore ? rows.slice(0, filters.limit) : rows;
    const nextCursor = hasMore && items.length > 0 ? (items[items.length - 1]!.created_at) : null;

    return { items, nextCursor, hasMore, limit: filters.limit };
  }

  async getById(id: string, orgId: string, projectId: string): Promise<AgentRun | null> {
    const row = this.db.prepare(
      'SELECT * FROM agent_runs WHERE id = ? AND org_id = ? AND project_id = ?'
    ).get(id, orgId, projectId) as AgentRun | undefined;
    return row ?? null;
  }
}
