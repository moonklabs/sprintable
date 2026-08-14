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
  // #2577: server key renamed sprintable -> sprintable-mcp (BE agent_onboarding_config.py SSOT).
  mcpServers: { 'sprintable-mcp': McpServerConfig };
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
 * 배포 전(디디 미착지)이거나 응답에 `prompt_file`이 없을 때만 쓰는 폴백. **다운로드 파일명으로는
 * 쓰지 말 것** — 유저 정체성 파일(CLAUDE.md 등)과 이름이 충돌한다(아래 KIT_FILENAME 참고). 전달
 * 카피에서 "이 런타임의 지침파일 컨벤션은 X"를 설명하는 용도로만 참조한다. */
export const RUNTIME_GUIDE_FILENAME_FALLBACK: Record<string, string> = {
  'claude-code': 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  cursor: 'CLAUDE.md',
};

/**
 * 채용 kit 다운로드/복사 파일명 — BE `agent_onboarding_config.py::KIT_FILENAME`과 동일 문자열,
 * 런타임 무관 단일 상수(story b1fe41cf, 정체성 파일 덮어쓰기 버그 fix). 예전엔 이 값을
 * `RUNTIME_GUIDE_FILENAME_FALLBACK`/`prompt_file`(CLAUDE.md/AGENTS.md/GEMINI.md 런타임별 리터럴)로
 * 채웠는데, 유저가 그 파일을 프로젝트 루트에 저장하면 자기 에이전트의 진짜 정체성 파일을 그대로
 * 덮어썼다 — BE의 `_connection_artifact` 엔드포인트(사후 재발급용)는 #1967에서 이미 고쳤으나,
 * recruit() 응답을 직접 쓰는 이 채용 위저드(STEP4)는 별개 경로라 반영이 안 돼 있었다(2026-07-08
 * 재발견). 그 어떤 런타임의 정체성 파일명과도 충돌하지 않는다.
 */
export const KIT_FILENAME = 'SPRINTABLE_ONBOARDING.md';

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
/**
 * story #2377 §2(규격 A) — 「깨우기」 축. 유나양 규격(doc `runtime-connect-guidance-spec-2377`
 * v1.2) §1: 「도구를 어떻게 받는가(MCP/SSE)」와 「어떻게 깨어나는가」는 독립된 두 축인데, BE
 * `is_connector_routed`는 그 둘을 하나로 묶어 판단한다 — codex는 MCP-native로 분류돼 「이미
 * 설정 끝, 별도 조치 불필요」 문구를 받지만 실제로는 `connectors/codex-sprintable/` 러너가
 * 있어야 세션이 깨어난다(claude-code도 마찬가지 — MCP-native인데 실제로는 `packages/fakechat`
 * 채널 플러그인이 깨운다). MCP만으로는 「어떤 런타임도」 안 깨어난다는 것이 실측(5/5)이다.
 *
 * 이 표는 BE 계약이 아니라 `apps/web/public/onboarding-guide.txt`(:152-165, "Runtime catalog" 표)
 * 정적 사실을 FE에 미러한 것 — RUNTIME_CAPABILITIES_FALLBACK과 같은 성격의
 * 정적 참조 데이터라, 이번 판은 BE 계약을 새로 만들지 않고(스코프 밖) FE에서 직접 잰다. 런타임이
 * 늘면 이 표도 같이 늘어야 한다(BE `MCP_NATIVE_RUNTIMES`가 늘 때와 같은 타이밍) — 그 트레이드
 * 오프를 감수하는 이유는 이 정보가 «서버 상태»가 아니라 «연동 방식에 대한 고정 사실»이기
 * 때문이다(BE가 매 요청마다 계산할 것이 없다).
 */
export type RuntimeWakeMethod = 'channel-plugin' | 'channel-plugin-marketplace' | 'connector-host' | 'connector-sidecar' | 'connector-sdk' | 'unknown';

export interface RuntimeWakeInfo {
  method: RuntimeWakeMethod;
  /** onboarding-guide.txt Runtime catalog 표의 Adapter 열 그대로. */
  path: string;
}

/** slug이 아래 맵에 없으면(아직 등재 안 된 새 런타임) `unknown`으로 떨어진다 — 「없으면 없다고
 * 말한다」(§2). 침묵 대신 "아직 깨우는 방법이 없다"를 명시적으로 말할 수 있어야 한다는 것이
 * 이 스토리의 핵심 처방(A-1)이다. */
export const RUNTIME_WAKE_MECHANISM: Record<string, RuntimeWakeInfo> = {
  // story #2653(디디 「한 줄 설치」 착지, 2026-08-14) — marketplace add→install 실왕복
  // 실측 완료(claude plugin marketplace add moonklabs/sprintable-agent-plugins →
  // claude plugin install sprintable@moonklabs, 완전 격리 CLAUDE_CONFIG_DIR로 확認).
  // method를 별도 축으로 가른 이유: hermes/openclaw/opencode는 여전히 배포 경로가
  // 없어 그 사실을 그대로 말해야 하는데, claude-code만 이제 실제 명령이 있다 — 같은
  // 'channel-plugin' 키를 공유하면 "받는 경로는 아직 제공하지 않습니다" 문장이 실제
  // 명령과 모순되게 붙는다. path는 「명령 대상」이 아니라 그대로 노출되는 설치 명령.
  'claude-code': {
    method: 'channel-plugin-marketplace',
    path: 'claude plugin marketplace add moonklabs/sprintable-agent-plugins && claude plugin install sprintable@moonklabs',
  },
  hermes: { method: 'channel-plugin', path: 'connectors/hermes-sprintable/' },
  openclaw: { method: 'channel-plugin', path: 'connectors/openclaw-sprintable/' },
  opencode: { method: 'channel-plugin', path: 'connectors/opencode-sprintable/' },
  codex: { method: 'connector-host', path: 'connectors/codex-sprintable/' },
  gemini: { method: 'connector-host', path: 'connectors/gemini-sprintable/' },
  grok: { method: 'connector-host', path: 'connectors/grok-sprintable/' },
  pi: { method: 'connector-host', path: 'connectors/pi-sprintable/' },
  cursor: { method: 'connector-sidecar', path: 'connectors/cursor-sprintable/' },
  connector: { method: 'connector-sdk', path: 'connectors/sdk/' },
};

export function resolveRuntimeWakeInfo(runtime: string): RuntimeWakeInfo {
  return RUNTIME_WAKE_MECHANISM[runtime] ?? { method: 'unknown', path: '' };
}

/** story #2377 v1.3 §1.5/§3(③)/⑤ — ①(도구 전달) 축의 런타임별 «정확한 CLI 문구». 파일기반
 * MCP-native(claude-code 등)는 기존 kitOrientingConnectBodyMcp(".mcp.json → add to X")가 이미
 * 정확하다(진짜 파일을 붙이는 게 맞음). hermes/openclaw는 파일이 아니라 자기 CLI 명령으로
 * 등록하므로 "파일" 프레이밍을 쓰면 §0급 "화면이 틀린 것을 단정"이 재발한다 — 여기 등재된
 * 런타임만 그 정확한 명령으로 대체한다(등재 안 된 런타임은 기존 file-framing 그대로, 무회귀). */
export const RUNTIME_CONNECT_CLI: Record<string, string> = {
  hermes: 'hermes mcp add --url --auth',
  openclaw: "openclaw mcp set '<json>'",
};

/** story #2377 v1.3 §1.5/④(PO+유나 2026-08-05 정정) — ①이 "실제로 도착했다"는 확認 등급.
 * 호스트 자기신고("Added"/"enabled")나 "config가 유효하게 저장됨"만으로는 success를 켜지
 * 않는다 — 그게 A-3(§2) 거짓성공의 화면판이다. 'confirmed'는 «우리 팀이 실제로 실측해
 * 도구가 왔음을 확認한» 날짜 있는 사실만(codex/hermes) — 'config-verified'(openclaw)는 host가
 * config를 유효로 저장한 것만 확認됐을 뿐 실제 도구 도착은 미확認이라 success 색을 쓰지 않는다.
 * 나머지 전부(gemini/grok/pi/cursor 등)는 'unmeasured' — 아직 안 쟀음(§6). 별건 C(BE 실호출
 * 도착 신호)가 서면 이 표는 그 신호로 교체된다(지금은 정적 스냅샷). */
export type ConnectConfirmTier = 'confirmed' | 'config-verified' | 'unmeasured';

export interface RuntimeConnectConfirm {
  tier: ConnectConfirmTier;
  /** 'confirmed'일 때만 — 팀이 실제로 실측한 날짜(호스트 주장이 아니라 우리 쪽 실측). */
  measuredAt?: string;
}

export const RUNTIME_CONNECT_CONFIRM: Record<string, RuntimeConnectConfirm> = {
  // PO+유나 정정(2026-08-05, #2856 design:changes) — codex ①은 matrix 정본상 [설정검증]뿐(도구
  // 목록 미확認 — spec-2377 §2가 #2382를 인용). 여기서 confirmed로 두면 "거짓성공 방지 배지"가
  // 스스로 거짓성공을 켜는 자리라 config-verified로 내린다.
  codex: { tier: 'config-verified' },
  hermes: { tier: 'confirmed', measuredAt: '2026-08-05' },
  // claude-code — [라이브] 자기증명(이 세션 자체가 .mcp.json http를 실사용 중). matrix 정본에
  // claude-code 행이 없어 안 넣으면 confirmed=hermes 한 종뿐으로 플래그십 런타임이 무배지가 된다.
  'claude-code': { tier: 'confirmed', measuredAt: '2026-08-05' },
  openclaw: { tier: 'config-verified' },
};

export function resolveConnectConfirm(runtime: string): RuntimeConnectConfirm {
  return RUNTIME_CONNECT_CONFIRM[runtime] ?? { tier: 'unmeasured' };
}

export const RUNTIME_CAPABILITIES_FALLBACK: RuntimeCapabilityItem[] = [
  { slug: 'claude-code', display_name: 'Claude Code', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'CLAUDE.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'codex', display_name: 'Codex', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'AGENTS.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'connector', display_name: 'Connector', supported: true, tier: 'experimental', transport: null, mcp_transport: [], prompt_file: 'AGENT_INSTRUCTIONS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'cursor', display_name: 'Cursor', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'AGENTS.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'gemini', display_name: 'Gemini', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'GEMINI.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'grok', display_name: 'Grok', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  // story #2857 후속 — hermes ①(http mcp_config)만 재분류·BE 실출력 그대로 미러(디디 실측).
  // ⛔②(guide_filename/supports_event_push)는 claude-code 행과 다르게 «유지» — 복사하면
  // hermes ②커넥터 안내가 조용히 사라진다(§7 "한 축이 두 물음" 함정, PO+유나 2026-08-05 정정).
  { slug: 'hermes', display_name: 'Hermes', supported: true, tier: 'full', transport: 'http', mcp_transport: ['http', 'stdio'], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'openclaw', display_name: 'OpenClaw', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'opencode', display_name: 'OpenCode', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'pi', display_name: 'Pi', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
];
