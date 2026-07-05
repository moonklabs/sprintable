/**
 * E-RECRUIT S4 — 채용관(Recruiter) 도메인 타입. BE 계약(S1/S3, 실측 origin/develop) 그대로 미러.
 * `role_templates` GET 목록/`agents/{id}/recruit` POST 응답 — 재조립 없이 서버 shape 그대로 소비.
 */

export interface RoleTemplateSummary {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string | null;
  default_tool_groups: string[];
  default_workflow_recipe_slug: string | null;
  is_builtin: boolean;
  tier: string;
  version: number;
}

export interface McpServerConfig {
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface McpConfigBundle {
  mcpServers: { sprintable: McpServerConfig };
}

export type Transport = 'http' | 'stdio';

export interface RecruitResponse {
  agent_id: string;
  persona_id: string;
  role_template_slug: string;
  /** 자율 운영 지침(CLAUDE.md 본문) — read-only, deterministic 합성. */
  system_prompt: string;
  tool_allowlist: string[];
  /** 실 key 평문 — 이 응답에서만 1회 노출(S3 G2). */
  api_key: string;
  default_transport: Transport;
  mcp_config: McpConfigBundle;
  mcp_config_alternatives: Partial<Record<Transport, McpConfigBundle>>;
}

/** 런타임별 지침 파일명(P0=Claude Code 기준·핸드오프 §STEP3). */
export const RUNTIME_GUIDE_FILENAME: Record<string, string> = {
  'claude-code': 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  cursor: 'CLAUDE.md',
  connector: 'CLAUDE.md',
};

/** 런타임 값(순서=UI 노출 순서). 브랜드명은 컴포넌트에서 직접 리터럴(비번역 고유명사),
 * "커넥터"만 i18n 리소스에서 라벨 조회. */
export const RUNTIME_VALUES = ['claude-code', 'codex', 'gemini', 'cursor', 'connector'] as const;

/** BE `SUPPORTED_RUNTIMES`(agent_onboarding_config.py) 실측 — 현재 P0=Claude Code 단일 지원.
 * 나머지 4종은 E-RECRUIT S5(런타임별 config emit 확장, ready-for-dev·미착지)가 실제 지원을 追加할
 * 때까지 UI엔 노출하되 선택 비활성(곧 지원) — recruit() 400을 유저에게 안 겪게 함. */
export const RUNTIME_SUPPORTED: readonly string[] = ['claude-code'];
