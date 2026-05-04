import type { PGlite } from '@electric-sql/pglite';
import type {
  ITeamMemberRepository,
  TeamMember,
  CreateTeamMemberInput,
  UpdateTeamMemberInput,
  TeamMemberListFilters,
} from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

interface TeamMemberRow extends Omit<TeamMember, 'is_active' | 'type'> {
  is_active: number;
  type: string;
}

function hydrate(row: TeamMemberRow): TeamMember {
  return {
    ...row,
    is_active: Boolean(row.is_active),
    type: row.type as 'human' | 'agent',
  };
}

export class PgliteTeamMemberRepository implements ITeamMemberRepository {
  constructor(private readonly db: PGlite) {}

  async list(filters: TeamMemberListFilters): Promise<TeamMember[]> {
    let query = 'SELECT * FROM team_members WHERE org_id = ? AND deleted_at IS NULL';
    const params: SqlParam[] = [filters.org_id];
    if (filters.project_id) { query += ' AND project_id = ?'; params.push(filters.project_id); }
    if (filters.type) { query += ' AND type = ?'; params.push(filters.type); }
    if (filters.is_active != null) { query += ' AND is_active = ?'; params.push(filters.is_active ? 1 : 0); }
    if (filters.cursor) { query += ' AND created_at > ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at ASC';
    if (filters.limit != null) { query += ' LIMIT ?'; params.push(filters.limit + 1); }
    const rows = (await this.db.query(...toPos(query, params))).rows as unknown as TeamMemberRow[];
    return rows.map(hydrate);
  }

  async getById(id: string): Promise<TeamMember> {
    const row = (await this.db.query(...toPos('SELECT * FROM team_members WHERE id = ? AND deleted_at IS NULL', [id]))).rows[0] as TeamMemberRow | undefined;
    if (!row) throw new NotFoundError('Team member not found');
    return hydrate(row);
  }

  async getByUserId(userId: string, orgId: string): Promise<TeamMember | null> {
    const row = (await this.db.query(...toPos('SELECT * FROM team_members WHERE user_id = ? AND org_id = ? AND deleted_at IS NULL', [userId, orgId]))).rows[0] as TeamMemberRow | undefined;
    return row ? hydrate(row) : null;
  }

  async create(input: CreateTeamMemberInput): Promise<TeamMember> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO team_members (id, org_id, project_id, user_id, name, email, role, type, is_active, webhook_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, input.org_id, input.project_id, input.user_id ?? null, input.name, input.email ?? null,
      input.role ?? 'member', input.type ?? 'human', (input.is_active ?? true) ? 1 : 0,
      (input as { webhook_url?: string | null }).webhook_url ?? null, now, now,
    ]));
    return this.getById(id);
  }

  async update(id: string, input: UpdateTeamMemberInput): Promise<TeamMember> {
    const ALLOWED: (keyof UpdateTeamMemberInput)[] = ['name', 'email', 'role', 'is_active', 'webhook_url'];
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const key of ALLOWED) {
      if (key in input) {
        sets.push(`${key} = ?`);
        const val = input[key];
        params.push(key === 'is_active' ? (val ? 1 : 0) : (val as SqlParam));
      }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);
    await this.db.query(...toPos(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params));
    return this.getById(id);
  }

  async delete(id: string, orgId: string): Promise<void> {
    await this.db.query(...toPos('UPDATE team_members SET deleted_at = ? WHERE id = ? AND org_id = ?', [new Date().toISOString(), id, orgId]));
  }
}
