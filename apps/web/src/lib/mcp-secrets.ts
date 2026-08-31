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

  // story #3174 — 이전엔 `allowlist.length > 0 && ...`라 MCP_ALLOWED_TOKEN_REFS가
  // 미설정/빈 문자열이면 이 검사 자체가 통째로 스킵됐다(fail-open — 다른 baseline
  // 항목들과 위험 방향이 반대). 도입 커밋(0fa2c8d42, "restrict external mcp token
  // refs")의 자기 테스트 전부가 성공 케이스마다 MCP_ALLOWED_TOKEN_REFS를 명시로
  // 채워서 시험했다 — "미설정=허용"을 의도해서 검증한 흔적이 0건이었다(스캐폴딩
  // 단계에서 배선을 미루다 잠긴 gap으로 판단). allowlist가 정본이므로 비어 있으면
  // "아무것도 허용 안 함"이 안전측 — 값을 채워야만 통과한다.
  const allowlist = listAllowedMcpTokenRefs(env.MCP_ALLOWED_TOKEN_REFS);
  if (!allowlist.includes(tokenRef)) {
    throw new Error(`token_ref_not_allowlisted: ${tokenRef}`);
  }

  const token = env[tokenRef];
  if (!token) {
    throw new Error(`missing_token_ref: ${tokenRef}`);
  }

  return token;
}
