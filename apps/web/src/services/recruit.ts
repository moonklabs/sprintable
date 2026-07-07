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
  /** supported=false면 항상 null. "full"=확정 지침파일 매핑 있음(claude-code만)·"experimental"=
   * config emit은 되나 S7 프롬프트 shaping 前 generic fallback(codex/gemini/cursor/connector). */
  tier: 'full' | 'experimental' | null;
  transport: string | null;
  mcp_transport: string[];
  prompt_file: string | null;
  guide_filename: string | null;
  supports_event_push: boolean;
  icon: string | null;
}

/** BE `runtime-capabilities` 미배포(디디 S6 미착지) 동안의 폴백 — S4 당시 하드코딩과 동일한
 * "Claude Code만 활성" 동작을 그대로 보존해 회귀 0(엔드포인트 배포되면 자동으로 동적 전환). */
export const RUNTIME_CAPABILITIES_FALLBACK: RuntimeCapabilityItem[] = [
  { slug: 'claude-code', display_name: 'Claude Code', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['stdio'], prompt_file: 'CLAUDE.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'codex', display_name: 'Codex', supported: false, tier: null, transport: null, mcp_transport: [], prompt_file: null, guide_filename: null, supports_event_push: false, icon: null },
  { slug: 'gemini', display_name: 'Gemini', supported: false, tier: null, transport: null, mcp_transport: [], prompt_file: null, guide_filename: null, supports_event_push: false, icon: null },
  { slug: 'cursor', display_name: 'Cursor', supported: false, tier: null, transport: null, mcp_transport: [], prompt_file: null, guide_filename: null, supports_event_push: false, icon: null },
];
