import { z } from 'zod';

export const MCP_TOKEN_REF_PATTERN = /^MCP_TOKEN_[A-Z0-9_]+$/;
export const MCP_TOKEN_REF_MESSAGE = 'token_ref must use the MCP_TOKEN_ namespace';

export const mcpTokenRefSchema = z.string().min(1).regex(MCP_TOKEN_REF_PATTERN, MCP_TOKEN_REF_MESSAGE);

export function listAllowedMcpTokenRefs(raw = process.env.MCP_ALLOWED_TOKEN_REFS): string[] {
  if (!raw?.trim()) return [];
  return [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

export function resolveMcpTokenRef(tokenRef: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!MCP_TOKEN_REF_PATTERN.test(tokenRef)) {
    throw new Error(`invalid_token_ref_namespace: ${tokenRef}`);
  }

  const allowlist = listAllowedMcpTokenRefs(env.MCP_ALLOWED_TOKEN_REFS);
  if (allowlist.length > 0 && !allowlist.includes(tokenRef)) {
    throw new Error(`token_ref_not_allowlisted: ${tokenRef}`);
  }

  const token = env[tokenRef];
  if (!token) {
    throw new Error(`missing_token_ref: ${tokenRef}`);
  }

  return token;
}
