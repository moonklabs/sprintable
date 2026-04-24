export interface AgentApiKey {
  id: string;
  team_member_id: string;
  key_prefix: string;
  key_hash: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  scope: string[] | null;
}

export interface CreateAgentApiKeyInput {
  teamMemberId: string;
  keyPrefix: string;
  keyHash: string;
  expiresAt?: string | null;
  scope?: string[];
}

export interface IAgentApiKeyRepository {
  create(input: CreateAgentApiKeyInput): Promise<Pick<AgentApiKey, 'id' | 'key_prefix' | 'created_at'>>;
  list(teamMemberId: string): Promise<AgentApiKey[]>;
  revoke(keyId: string): Promise<void>;
}
