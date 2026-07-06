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

/** 런타임별 지침 파일명(P0=Claude Code 기준·핸드오프 §STEP3). E-RECRUIT S6가 이 값을
 * `RuntimeCapabilityItem.guide_filename`(BE `runtime-capabilities` 응답)으로 동적 대체할 때까지의
 * 폴백(BE 미배포·엔드포인트 404 시에만 사용). */
export const RUNTIME_GUIDE_FILENAME_FALLBACK: Record<string, string> = {
  'claude-code': 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  cursor: 'CLAUDE.md',
};

/**
 * E-RECRUIT S6 — `GET /api/v2/runtime-capabilities` 응답 항목(오르테가 확정 계약, 2026-07-06).
 * BE `agent_runtime.py::RuntimeCapability`(9종 `RuntimeType` 레지스트리) 확장분을 노출 —
 * `transport`/`guide_filename`이 AC의 `mcp_transport`/`prompt_file`에 대응.
 * `connector`(네이티브 미목록 런타임용 transport 카테고리)는 이 레지스트리에 없음 — RuntimeType
 * enum 자체가 아니라 FE 전용 catch-all 카드로 별도 취급(오르테가 확정).
 */
export interface RuntimeCapabilityItem {
  slug: string;
  display_name: string;
  supported: boolean;
  /** supported=true 내부 구분(유나 핸드오프 §3-1) — "full"=완전지원(무배지)·"experimental"=
   * config emit되나 프롬프트 shaping(S7) 前 부분지원(subtle info 배지). supported=false면 무관. */
  tier?: 'full' | 'experimental';
  /** 내부용 — 유저에게 노출 안 함(과기술 방지, 핸드오프 §3-1). */
  transport: 'stdio' | 'http' | 'connector';
  guide_filename: string;
  icon?: string;
}

/** BE `runtime-capabilities` 미배포(디디 S6 미착지) 동안의 폴백 — S4 당시 하드코딩과 동일한
 * "Claude Code만 활성" 동작을 그대로 보존해 회귀 0(엔드포인트 배포되면 자동으로 동적 전환). */
export const RUNTIME_CAPABILITIES_FALLBACK: RuntimeCapabilityItem[] = [
  { slug: 'claude-code', display_name: 'Claude Code', supported: true, transport: 'stdio', guide_filename: 'CLAUDE.md' },
  { slug: 'codex', display_name: 'Codex', supported: false, transport: 'stdio', guide_filename: 'AGENTS.md' },
  { slug: 'gemini', display_name: 'Gemini', supported: false, transport: 'stdio', guide_filename: 'GEMINI.md' },
  { slug: 'cursor', display_name: 'Cursor', supported: false, transport: 'stdio', guide_filename: 'CLAUDE.md' },
];
