import type { PGlite } from '@electric-sql/pglite';
import type {
  IAgentApiKeyRepository,
  AgentApiKey,
  CreateAgentApiKeyInput,
} from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

export class PgliteAgentApiKeyRepository implements IAgentApiKeyRepository {
  constructor(private readonly db: PGlite) {}

  async create(input: CreateAgentApiKeyInput): Promise<Pick<AgentApiKey, 'id' | 'key_prefix' | 'created_at'>> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ?? null;
    const scope = JSON.stringify(input.scope ?? ['read', 'write']);
    await this.db.query(...toPos(
      'INSERT INTO agent_api_keys (id, team_member_id, key_prefix, key_hash, created_at, expires_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, input.teamMemberId, input.keyPrefix, input.keyHash, now, expiresAt, scope]
    ));
    return { id, key_prefix: input.keyPrefix, created_at: now };
  }

  async list(teamMemberId: string): Promise<AgentApiKey[]> {
    const rows = (await this.db.query(...toPos(
      'SELECT * FROM agent_api_keys WHERE team_member_id = ? ORDER BY created_at DESC',
      [teamMemberId]
    ))).rows as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      scope: row.scope ? JSON.parse(row.scope as string) as string[] : ['read', 'write'],
    })) as unknown as AgentApiKey[];
  }

  async revoke(keyId: string): Promise<void> {
    await this.db.query(...toPos(
      'UPDATE agent_api_keys SET revoked_at = ? WHERE id = ?',
      [new Date().toISOString(), keyId]
    ));
  }
}
