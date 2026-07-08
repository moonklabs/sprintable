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
  // ~300직군 카탈로그 트랙(division/emoji nullable) — BE routers/role_templates.py RoleTemplateSummary와 동형.
  division: string | null;
  emoji: string | null;
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

/** 런타임별 지침 파일명(P0=Claude Code 기준·핸드오프 §STEP3) — BE `runtime-capabilities`가 아직
 * 배포 전(디디 미착지)이거나 응답에 `prompt_file`이 없을 때만 쓰는 폴백. */
export const RUNTIME_GUIDE_FILENAME_FALLBACK: Record<string, string> = {
  'claude-code': 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  cursor: 'CLAUDE.md',
};

/**
 * E-RECRUIT S6 — `GET /api/v2/runtime-capabilities` 응답 항목. **실측 계약**(BE PR #1911,
 * `backend/app/routers/runtime_capabilities.py::RuntimeCapability` 그대로 미러 — 2026-07-06
 * 착지 후 실 스키마로 정정. 착수 시점에 전달받은 요약과 실제 필드명·nullability·`connector` 취급이
 * 달라 PR diff를 직접 읽고 맞췄다):
 * - **`connector`도 레지스트리의 정식 slug**(10개 중 하나, `supported=true, tier="experimental"`) —
 *   FE 전용 catch-all 카드가 아니라 다른 experimental 런타임과 동일하게 지원 섹션에 데이터 기반으로
 *   렌더된다(당초 안내와 달랐던 부분).
 * - `guide_filename`은 connector 전용("CONNECTOR_SETUP.md")이고 **일반 런타임의 지침 파일명은
 *   `prompt_file`**(claude-code="CLAUDE.md", 나머지는 S7 shaping 전 generic fallback).
 * - `transport`(단수)는 edition 기본 transport(nullable) — E-MCP-OPT S3의 `default_transport`와
 *   같은 개념. `mcp_transport`(복수, 배열)가 그 런타임이 실제 지원하는 transport 집합.
 */
export interface RuntimeCapabilityItem {
  slug: string;
  display_name: string;
  supported: boolean;
  /** supported=false면 항상 null. "full"=확정 지침파일 매핑 있음(전 런타임 올지원 후 connector
   * 제외 전부)·"experimental"=config emit은 되나 특정 툴 미확정이라 generic fallback(connector만). */
  tier: 'full' | 'experimental' | null;
  transport: string | null;
  mcp_transport: string[];
  prompt_file: string | null;
  guide_filename: string | null;
  supports_event_push: boolean;
  icon: string | null;
}

/** BE `runtime-capabilities` 미배포/장애 동안의 폴백 — 전 런타임 올지원(story 6f6ac081) 후 실
 * SSOT(`list_runtime_capabilities()`)와 동기화한 스냅샷(2026-07-08). BE 엔드포인트 자체가
 * 죽었을 때만 노출되는 극단 경로라 여기서 갱신을 놓쳐도 기능은 안 깨지나(회귀는 아님), 낡은
 * "claude-code만" 상태를 보여주는 정합 갭이었음 — 실 응답과 동기화. */
export const RUNTIME_CAPABILITIES_FALLBACK: RuntimeCapabilityItem[] = [
  { slug: 'claude-code', display_name: 'Claude Code', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'CLAUDE.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'codex', display_name: 'Codex', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'AGENTS.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'connector', display_name: 'Connector', supported: true, tier: 'experimental', transport: null, mcp_transport: [], prompt_file: 'AGENT_INSTRUCTIONS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'cursor', display_name: 'Cursor', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'AGENTS.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'gemini', display_name: 'Gemini', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'GEMINI.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'grok', display_name: 'Grok', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'hermes', display_name: 'Hermes', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'openclaw', display_name: 'OpenClaw', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'opencode', display_name: 'OpenCode', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'pi', display_name: 'Pi', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
];
