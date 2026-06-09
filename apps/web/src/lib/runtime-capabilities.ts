/**
 * 에이전트 런타임 capability registry (FE 단일 출처 — E-CHAT-CMD S2).
 *
 * 백엔드 SSOT `backend/app/services/agent_runtime.py`(블루프린트
 * `blueprint-chat-command-skill-execution` §Task 1)와 값 정합. 셀렉터·배지가 이 단일
 * registry를 읽어 런타임별 슬래시 커맨드 지원 여부를 판정한다.
 *
 * - deterministicCommand: 런타임이 결정적 커맨드(모델 비경유, 직접 실행)를 지원하는가.
 * - commandEndpointAvailable: 커맨드 주입 엔드포인트가 존재하는가. opencode는 엔드포인트는
 *   있으나 결정적 실행은 아님(deterministic=false, endpoint=true → 부분 지원).
 *
 * 표시명(label)은 proper noun이라 i18n 미적용 — registry 상수에 둔다.
 */

export type RuntimeKey =
  | 'hermes'
  | 'openclaw'
  | 'gemini'
  | 'grok'
  | 'pi'
  | 'opencode'
  | 'claude-code'
  | 'codex'
  | 'cursor';

export interface RuntimeCapability {
  deterministicCommand: boolean;
  commandEndpointAvailable: boolean;
}

export interface RuntimeDef {
  key: RuntimeKey;
  label: string;
  capability: RuntimeCapability;
}

/** 커맨드 지원 3단계(capability 기반) + fallback 2종(빈값/미인식). */
export type CommandSupport = 'supported' | 'partial' | 'unsupported';
export type RuntimeStatus = CommandSupport | 'unset' | 'unknown';

/**
 * 드롭다운 옵션 순서 = 블루프린트 §3 표 순서(지원 → 부분 → 미지원으로 그룹핑).
 * 9 런타임, BE RuntimeType enum과 값 1:1 정합.
 */
export const RUNTIME_REGISTRY: readonly RuntimeDef[] = [
  { key: 'hermes', label: 'Hermes', capability: { deterministicCommand: true, commandEndpointAvailable: true } },
  { key: 'openclaw', label: 'OpenClaw', capability: { deterministicCommand: true, commandEndpointAvailable: true } },
  { key: 'gemini', label: 'Gemini', capability: { deterministicCommand: true, commandEndpointAvailable: true } },
  { key: 'grok', label: 'Grok', capability: { deterministicCommand: true, commandEndpointAvailable: true } },
  { key: 'pi', label: 'Pi', capability: { deterministicCommand: true, commandEndpointAvailable: true } },
  { key: 'opencode', label: 'OpenCode', capability: { deterministicCommand: false, commandEndpointAvailable: true } },
  { key: 'claude-code', label: 'Claude Code', capability: { deterministicCommand: false, commandEndpointAvailable: false } },
  { key: 'codex', label: 'Codex', capability: { deterministicCommand: false, commandEndpointAvailable: false } },
  { key: 'cursor', label: 'Cursor', capability: { deterministicCommand: false, commandEndpointAvailable: false } },
] as const;

const REGISTRY_BY_KEY: ReadonlyMap<string, RuntimeDef> = new Map(
  RUNTIME_REGISTRY.map((def) => [def.key, def]),
);

/** runtime_type 키 → registry 정의. 미등록/빈값은 undefined. */
export function getRuntimeDef(key: string | null | undefined): RuntimeDef | undefined {
  if (!key) return undefined;
  return REGISTRY_BY_KEY.get(key);
}

/** capability → 커맨드 지원 3단계 판정(BE get_runtime_capability와 동일 규칙). */
export function commandSupportFor(capability: RuntimeCapability): CommandSupport {
  if (capability.deterministicCommand) return 'supported';
  if (capability.commandEndpointAvailable) return 'partial';
  return 'unsupported';
}

/**
 * 저장된 runtime_type을 표시 상태로 정규화(AC2 fallback).
 * - null/빈값 → 'unset'(미설정, 신규 에이전트 기본 — 기능상 미지원이나 중립 표시)
 * - registry에 없는 값 → 'unknown'(미인식, 원값 보존 + 미지원 처리)
 * - 등록값 → capability 기반 supported/partial/unsupported
 */
export function resolveRuntimeStatus(runtimeType: string | null | undefined): RuntimeStatus {
  if (!runtimeType) return 'unset';
  const def = getRuntimeDef(runtimeType);
  if (!def) return 'unknown';
  return commandSupportFor(def.capability);
}

/**
 * runtime_type 키 → 사람이 읽는 표시명 (E-CHAT-CMD S8 #1 — hint·경고 카피의 {runtime} 바인딩용).
 * 등록키 → label(claude-code→"Claude Code") · 미등록값 → 원값 보존(S2 ⑤ 패턴) ·
 * null/빈값 → null(호출부가 i18n "런타임 미설정"으로 치환 — 순수 util은 번역 컨텍스트 없음).
 */
export function runtimeLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  return getRuntimeDef(key)?.label ?? key;
}
