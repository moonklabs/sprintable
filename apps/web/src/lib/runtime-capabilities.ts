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
 * 등록키 → label(claude-code→"Claude Code") · null/빈값/미등록값 → null(호출부가 i18n
 * "런타임 미설정"으로 치환하거나 라벨 자체를 생략 — 순수 util은 번역 컨텍스트가 없다).
 *
 * story #3103(DS·후속, 3505 design 판정 필수) — 미등록값 「원값 보존」(구 S2 ⑤ 패턴)을
 * 폐기했다. registry 미등재 runtime_type이 실제로 들어오면 raw key(예: "internal-beta")가
 * UI에 그대로 노출되는 잠복 클래스였다 — 전역 폴백 규칙("raw key 노출 0")과 충돌. 소비처
 * 전수 확認 결과 모든 호출부(command-hint-notice·chat-input·team-presence-panel·Avatar
 * 툴팁·workforce 상세 배지)가 이미 `?? fallback` 또는 truthy 체크로 null을 우아하게
 * 처리하고 있어 이 변경만으로 닫힌다(호출부 수정 0).
 */
export function runtimeLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  return getRuntimeDef(key)?.label ?? null;
}

/**
 * story #3092(3단계, 유나 규격 v3 doc cd8983c4 + 실행 패키지 doc 5745ad66) — 아바타 코너
 * 배지를 커넥터별 공식 아이콘으로 승격. 9종 중 claude-code·gemini는 3단계 착수 시점엔
 * 상표 사인오프 전이라 이니셜(«CC»·«G»)로 선출시했으나, **4단계(2026-08-26, 선생님 확定)**
 * — "연동 표시 목적 무변형 사용=통상 범위, 별도 상표 문의 불요" 판정으로 두 종 모두
 * 아이콘으로 스왑(승인 대기 해제). hermes는 3단계에서 실행 패키지가 지정한 repo 소스만
 * 조사해(favicon이 시스템 폰트 의존 유니코드 글리프 "⚕" 뿐) 벡터 자산 부재로 이니셜
 * 확定했으나, **5단계(2026-08-26, 선생님 재지시)** — nousresearch.com 자체 사이트의
 * 래스터 favicon/앱아이콘 세트(미조사 상태였음)에서 공식 마스코트 PNG를 발견해 아이콘으로
 * 재승격.
 *
 * `sourceNote`는 실행 패키지가 요구한 "각 아이콘 출처 URL 명기"를 코드에도 고정해 자산이
 * 바뀌어도 근거가 diff에 남게 한다(PR 본문과 이중 기록 — 실행 소스는 여기가 SSOT).
 */
export type ConnectorBadgeKind = 'icon' | 'initials';

export interface ConnectorBadgeDef {
  kind: ConnectorBadgeKind;
  /** kind='icon' 전용 — public/connector-icons/<key>.svg|png 상대경로(SVG 우선, 벡터
   * 부재 시 고해상 PNG도 허용 — hermes가 선례). */
  asset?: string;
  /** kind='icon' 전용 — 'color'=브랜드 원색 유지(디스크=테마 bg-card). 'mono'=단색 마크
   * (디스크=고정 밝은 배경, 무테마 — 다크 테마에서도 검정 마크 대비 확保). */
  colorMode?: 'color' | 'mono';
  /** kind='initials'일 때(디스크 항상 이니셜)이거나, kind='icon'인데 아바타가 minIconSize
   * 미만이어서 아이콘 대신 보일 때(§ minIconSize 참고) 디스크에 그릴 1~2자(중립 mono,
   * 브랜드색/서체 미모사). */
  initials?: string;
  /** kind='icon' 전용, optional — 이 값(px, 아바타 기준) 미만이면 아이콘을 안 쓴다.
   * 기본 28(전역 규격 §2, 대부분의 기하형 마크가 여기서도 식별됨). story #3092(5단계
   * delta, 유나 실측) — hermes처럼 상세한 초상형 아이콘은 28~47에서 blob으로 뭉개지는
   * 게 실측 확認돼 개별 override가 필요했다. 이 값 미만~28 이상 구간은 `initials`가
   * 있으면 그걸로, 없으면 바로 "Agent" 텍스트로 강등(28 미만은 항상 "Agent" 텍스트,
   * 전역 규칙 무변경). */
  minIconSize?: number;
  /** 실행 패키지 §5/① 요건 — 실제 pull한 출처(공식 소스 우선·애그리게이터는 대조 후만). */
  sourceNote: string;
}

export const CONNECTOR_BADGE_REGISTRY: Record<RuntimeKey, ConnectorBadgeDef> = {
  // story #3092(4단계, 선생님 확定 2026-08-26) — "연동 표시 목적 무변형 사용=통상 범위,
  // 문의 불요" 판정으로 이니셜→아이콘 스왑(승인 대기 해제). claude=Anthropic 제품 스타버스트
  // 마크(회사 삼각형 워드마크 "Anthropic"이 아니라 Claude 자체 마크 — claude-code 커넥터
  // 정체성과 더 정확히 대응). gemini=스파클 마크(유나 시안이 쓴 "Gemini 스파클"과 형태 일치.
  'claude-code': { kind: 'icon', asset: '/connector-icons/claude-code.svg', colorMode: 'mono', sourceNote: 'LobeHub icons-static-svg claude.svg(Anthropic 공식 Claude 스타버스트 마크 대조) — anthropic.com에 공개 브랜드/프레스킷 페이지를 못 찾았고 claude.ai 앱 도메인은 자동화 접근 403이라 1차 소스 직접 확認 불가, 애그리게이터 사용. 선생님 확定(2026-08-26): 연동표시 목적 무변형 사용=통상 범위, 별도 상표 문의 불요' },
  gemini: { kind: 'icon', asset: '/connector-icons/gemini.svg', colorMode: 'mono', sourceNote: 'LobeHub icons-static-svg gemini.svg(Google 공식 Gemini 스파클 마크 대조) — Google 브랜드 리소스 센터가 파트너 인증 포털(partnermarketinghub.withgoogle.com)로 리다이렉트돼 1차 소스 직접 확認 불가, 애그리게이터 사용. 선생님 확定(2026-08-26): 연동표시 목적 무변형 사용=통상 범위, 별도 상표 문의 불요' },
  codex: { kind: 'icon', asset: '/connector-icons/codex.svg', colorMode: 'mono', sourceNote: 'LobeHub icons-static-svg codex.svg(OpenAI 공식 Codex 마크 대조) — openai.com/brand 직접 접근 차단(Cloudflare)으로 애그리게이터 사용' },
  grok: { kind: 'icon', asset: '/connector-icons/grok.svg', colorMode: 'mono', sourceNote: 'LobeHub icons-static-svg grok.svg — x.ai/legal/brand-guidelines 직접 접근 차단(Cloudflare)으로 애그리게이터 사용' },
  cursor: { kind: 'icon', asset: '/connector-icons/cursor.svg', colorMode: 'mono', sourceNote: 'simple-icons cursor.svg(PO/유나 사전 확保)' },
  opencode: { kind: 'icon', asset: '/connector-icons/opencode.svg', colorMode: 'mono', sourceNote: 'simple-icons opencode.svg(PO/유나 사전 확保)' },
  openclaw: { kind: 'icon', asset: '/connector-icons/openclaw.svg', colorMode: 'color', sourceNote: '1st-party: https://openclaw.ai/favicon.svg(공식 사이트 자체 favicon·헤더 로고와 동일 — repo README "🦞 the lobster way" 브랜딩과 정합)' },
  pi: { kind: 'icon', asset: '/connector-icons/pi.svg', colorMode: 'mono', sourceNote: '1st-party: https://pi.dev/logo-auto.svg(github.com/earendil-works/pi README가 직접 링크하는 공식 자산). ⚠️내부에 prefers-color-scheme 미디어쿼리가 있어 OS 테마 기준으로 흑/백이 갈린다(앱 테마와 별개 축) — 무변형 원칙상 후처리로 강제하지 않음, 극단적 조합(라이트 앱+다크 OS 등)에서 대비가 낮아질 수 있는 자산 자체의 한계로 기록' },
  // story #3092(5단계, 선생님 재지시 2026-08-26) — 3단계에서 "벡터 자산 부재"로 이니셜
  // 강등했던 판정이 "래스터도 안 찾아봤다"는 지적으로 재조사 — nousresearch.com 자체
  // HTML(og:image·apple-touch-icon·favicon 링크 전수)에서 실제 공식 래스터 발견,
  // 이니셜 폐기하고 아이콘으로 승격.
  //
  // story #3092(5단계 delta, 유나 실측 2026-08-26) — 이 마크는 기하형(별/스파클/큐브 등)이
  // 아니라 상세 초상 일러스트라 av48 미만에서 검정 blob으로 뭉개짐이 실측 확認됨(av48=
  // 로고 13px에서 확신 식별, av36 이하 실패). 전역 임계(28) 대신 minIconSize=48로
  // override하고, 28~47 구간은 이니셜 "He"로 폴백(28 미만은 기존 규칙대로 "Agent" 텍스트).
  hermes: {
    kind: 'icon',
    asset: '/connector-icons/hermes.png',
    colorMode: 'mono',
    minIconSize: 48,
    initials: 'He',
    sourceNote: '1st-party: https://nousresearch.com/wp-content/uploads/2024/03/android-chrome-512x512-1-300x300.png(자사 사이트 자체 favicon/앱아이콘 세트 중 하나, 300×300 PNG — Nous Research 브랜드 마스코트 일러스트. 배경 투명·검정 단색 라인아트라 mono 취급). 3단계 "벡터 자산 부재" 판정은 hermes-agent repo의 유니코드 글리프 favicon만 조사한 것이었고, 공식 사이트 자체의 래스터 아이콘 세트는 미조사 상태였음(선생님 재지시로 발견) — 이 판정으로 대체. minIconSize=48·이니셜 "He"는 유나 실측(av48 확신 식별·av36 이하 blob)',
  },
};
