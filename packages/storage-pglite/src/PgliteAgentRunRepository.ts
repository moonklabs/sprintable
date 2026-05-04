import type { PGlite } from '@electric-sql/pglite';
import type {
  IAgentRunRepository,
  AgentRun,
  AgentRunListFilters,
  AgentRunListResult,
} from '@sprintable/core-storage';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

export class PgliteAgentRunRepository implements IAgentRunRepository {
  constructor(private readonly db: PGlite) {}

  async list(filters: AgentRunListFilters): Promise<AgentRunListResult> {
    let query = 'SELECT * FROM agent_runs WHERE org_id = ? AND project_id = ?';
    const params: SqlParam[] = [filters.orgId, filters.projectId];

    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    const fromDate = filters.from ?? new Date(Date.now() - 7 * 86400000).toISOString();
    query += ' AND created_at >= ?';
    params.push(fromDate);

    if (filters.to) {
      query += ' AND created_at <= ?';
      params.push(filters.to);
    }

    if (filters.cursor) {
      query += ' AND created_at < ?';
      params.push(filters.cursor);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(filters.limit + 1);

    const rows = (await this.db.query(...toPos(query, params))).rows as unknown as AgentRun[];
    const hasMore = rows.length > filters.limit;
    const items = hasMore ? rows.slice(0, filters.limit) : rows;
    const nextCursor = hasMore && items.length > 0 ? (items[items.length - 1]!.created_at) : null;

    return { items, nextCursor, hasMore, limit: filters.limit };
  }

  async getById(id: string, orgId: string, projectId: string): Promise<AgentRun | null> {
    const row = (await this.db.query(...toPos(
      'SELECT * FROM agent_runs WHERE id = ? AND org_id = ? AND project_id = ?',
      [id, orgId, projectId]
    ))).rows[0] as AgentRun | undefined;
    return row ?? null;
  }
}
