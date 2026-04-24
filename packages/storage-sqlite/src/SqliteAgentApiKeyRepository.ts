import type { DatabaseSync } from 'node:sqlite';
import type {
  IAgentApiKeyRepository,
  AgentApiKey,
  CreateAgentApiKeyInput,
} from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

export class SqliteAgentApiKeyRepository implements IAgentApiKeyRepository {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: CreateAgentApiKeyInput): Promise<Pick<AgentApiKey, 'id' | 'key_prefix' | 'created_at'>> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ?? null;
    this.db.prepare(
      'INSERT INTO agent_api_keys (id, team_member_id, key_prefix, key_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, input.teamMemberId, input.keyPrefix, input.keyHash, now, expiresAt);
    return { id, key_prefix: input.keyPrefix, created_at: now };
  }

  async list(teamMemberId: string): Promise<AgentApiKey[]> {
    return this.db.prepare(
      'SELECT * FROM agent_api_keys WHERE team_member_id = ? ORDER BY created_at DESC'
    ).all(teamMemberId) as unknown as AgentApiKey[];
  }

  async revoke(keyId: string): Promise<void> {
    this.db.prepare(
      'UPDATE agent_api_keys SET revoked_at = ? WHERE id = ?'
    ).run(new Date().toISOString(), keyId);
  }
}
