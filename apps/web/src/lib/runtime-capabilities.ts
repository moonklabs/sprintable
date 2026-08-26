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
  | 'cursor'
  | 'system-publisher';

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
 *
 * story #3107(#3092 후속, 선생님 지시 2026-08-26) — `system-publisher`는 위 9종과 달리
 * 사람이 붙이는 실 코딩 에이전트 런타임이 아니라 시스템이 발행한 메시지/기록의 발신
 * 주체를 나타내는 예약값이다(#3103/#3508 QA 실측으로 registry 밖 실재 확認). capability는
 * 둘 다 false(슬래시 커맨드 지원 대상 자체가 아님 — 사실을 그대로 반영, 억지 값 아님)로
 * 두고 label만 부여해 `runtimeLabel()`/뱃지가 다른 9종과 동일 경로로 동작하게 한다. 단
 * "실 에이전트가 고를 수 있는 런타임" 목록(workforce 상세 페이지의 런타임 드롭다운)에는
 * 노출하지 않는다 — 그 목록에서만 명시적으로 걸러낸다(아래 workforce 상세 페이지 참고).
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
  { key: 'system-publisher', label: 'Sprintable', capability: { deterministicCommand: false, commandEndpointAvailable: false } },
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
  /** kind='icon' 전용 — public/connector-icons/<key>.svg|png|jpg 상대경로(SVG 우선,
   * 벡터 부재 시 고해상 PNG도 허용 — hermes가 선례. story #3119(tokscale 소스)부터 JPG도
   * 허용 — 지정 소스가 벡터를 안 주는 경우 원본 그대로 무변형 사용). */
  asset?: string;
  /** kind='icon' 전용 — 디스크 배경 전략(아이콘 자체 색상 수와는 무관 — 이름은 "단색
   * 마크" 유래지만 실제 의미는 "디스크 고정" 여부):
   * - 'color': 디스크=테마 토큰(bg-card). 아이콘이 어떤 색이든 그 원색을 그대로 두고
   *   테마를 따라가는 디스크가 자체 대비를 낸다(예: openclaw의 그라디언트 레드).
   * - 'mono': 디스크=고정 밝은 배경(무테마 — 다크 테마에서도 대비 확保). 원래는
   *   흑백 단색 아이콘(cursor 등)을 위한 값이었으나, story #3092(#3107 delta, 유나
   *   확定 2026-08-26) — sprintable-symbol처럼 다색(인디고+시안) 아이콘이라도 "항상
   *   밝은 디스크 위에 얹혀야 하는" 경우(자사 브랜드 마크·투명배경 파생판)도 이 값을
   *   재사용한다(disc:'light' 규격 표기와 동일 동작 — 아이콘 자체 색은 무변형 유지). */
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
  // story #3119(선생님 지정 소스 2026-08-26) — tokscale(github.com/junhoyeo/tokscale
  // .github/assets) 갱신. 5종은 실물 대조로 「기존보다 정확/공식적」 확認 후 스왑:
  // claude=Anthropic 실제 앱아이콘 프레젠테이션(주황 배경+흰 스타버스트, 기존 LobeHub
  // mono 단순화판보다 브랜드 원본에 가까움). codex=OpenAI 실제 6-잎 매듭 마크로 교체
  // (기존 codex.svg는 대조해보니 OpenAI 마크가 아니라 범용 "터미널 말풍선" 글리프였음 —
  // 이번 교체로 실제 오류 정정 겸함, «Codex» 라벨은 그대로 유지). gemini=Google 공식
  // 멀티컬러 스파클 원본(기존 LobeHub mono 단색판 대비 업그레이드). jpg 3종(claude·
  // openclaw)은 배경이 solid 브랜드색(흰색 아님 — 실측: claude #DA7757·openclaw
  // #F70515)이라 bg-white 고정 디스크는 오히려 어색해 colorMode='color'(테마 bg-card)
  // 유지 — 디스크 코너 갭(사각 이미지 vs 원형 마스크)은 브랜드 원색이 대부분을 채워
  // 작다, 다크 테마 실렌더는 유나 판정 축.
  'claude-code': { kind: 'icon', asset: '/connector-icons/claude-code.jpg', colorMode: 'color', sourceNote: 'tokscale(github.com/junhoyeo/tokscale .github/assets/client-claude.jpg, 선생님 지정 소스 2026-08-26) — Anthropic 공식 Claude 앱아이콘 프레젠테이션(주황 배경+흰 스타버스트). 배경 실측 solid #DA7757(흰색 아님) → colorMode=color 유지.' },
  gemini: { kind: 'icon', asset: '/connector-icons/gemini.png', colorMode: 'mono', sourceNote: 'tokscale(github.com/junhoyeo/tokscale .github/assets/client-gemini.png, 선생님 지정 소스 2026-08-26) — Google 공식 멀티컬러 Gemini 스파클 원본(기존 LobeHub mono 단색판 대비 브랜드 정확도 업그레이드). 배경 실측 solid 흰색 → bg-white 고정 디스크 seamless.' },
  codex: { kind: 'icon', asset: '/connector-icons/codex.jpg', colorMode: 'mono', sourceNote: 'tokscale(github.com/junhoyeo/tokscale .github/assets/client-openai.jpg, 선생님 지정 소스 2026-08-26) — OpenAI 공식 6-잎 매듭 마크(라벨은 «Codex» 그대로, 로고만 OpenAI). 기존 codex.svg(LobeHub)는 실물 대조 결과 OpenAI 마크가 아니라 범용 터미널 말풍선 글리프였음 — 이번 교체가 그 오류도 정정한다. 배경 실측 solid 흰색 → bg-white 고정 디스크 seamless.' },
  grok: { kind: 'icon', asset: '/connector-icons/grok.svg', colorMode: 'mono', sourceNote: 'LobeHub icons-static-svg grok.svg — x.ai/legal/brand-guidelines 직접 접근 차단(Cloudflare)으로 애그리게이터 사용. story #3119: tokscale .github/assets에 grok 항목 부재 확認(PO 실측) — 스코프 밖, 무변경.' },
  cursor: { kind: 'icon', asset: '/connector-icons/cursor.jpg', colorMode: 'mono', sourceNote: 'tokscale(github.com/junhoyeo/tokscale .github/assets/client-cursor.jpg, 선생님 지정 소스 2026-08-26) — Cursor 공식 큐브/화살표 마크(기존 simple-icons판과 동일 마크, 출처만 선생님 지정 소스로 정렬). 배경 실측 solid 흰색 → bg-white 고정 디스크 seamless.' },
  // story #3119 — tokscale에 opencode·pi 항목이 있으나 실물 대조 결과 각 브랜드의 실제
  // 마크가 아닌 것으로 판단해 스왑 보류(PO/선생님 확定 2026-08-26, 비교 스크린샷 PR
  // 첨부): opencode는 검은 배경에 흰 사각형+회색 조각(자기네 각진 지오메트릭 마크와
  // 무관 — 아마 tokscale 자신의 스크린샷/플레이스홀더), pi는 조잡한 픽셀 "P" 블록(과거
  // #3092 3단계에서 겪은 "오인 Pi"—Inflection AI Pi와 혼동—재발 의심 케이스와 형태가
  // 닮음). tokscale은 자기네 사용량 추적 툴의 클라이언트 아이콘 모음일 뿐 정식 로고
  // 큐레이션 소스가 아니라 이 2종만은 기존 검증 자산(simple-icons·pi.dev 1st-party)을
  // 유지한다.
  opencode: { kind: 'icon', asset: '/connector-icons/opencode.svg', colorMode: 'mono', sourceNote: 'simple-icons opencode.svg(PO/유나 사전 확保). story #3119: tokscale client-opencode.png는 실물 대조 결과 OpenCode 실제 마크가 아닌 것으로 판단(검은 배경+흰 사각형/회색 조각, 자기네 지오메트릭 마크와 무관)돼 스왑 보류 — 기존 자산 유지.' },
  openclaw: { kind: 'icon', asset: '/connector-icons/openclaw.jpg', colorMode: 'color', sourceNote: 'tokscale(github.com/junhoyeo/tokscale .github/assets/client-openclaw.jpg, 선생님 지정 소스 2026-08-26) — 상세 랍스터 마크(repo README "🦞 the lobster way" 브랜딩과 정합). 배경 실측 solid #F70515(흰색 아님) → colorMode=color 유지. 이전 자산(openclaw.ai/favicon.svg 1st-party)보다 provenance는 3rd-party 애그리게이터로 낮아지나 선생님이 이 소스를 직접 지정·소싱 승인(2026-08-26).' },
  pi: { kind: 'icon', asset: '/connector-icons/pi.svg', colorMode: 'mono', sourceNote: '1st-party: https://pi.dev/logo-auto.svg(github.com/earendil-works/pi README가 직접 링크하는 공식 자산). ⚠️내부에 prefers-color-scheme 미디어쿼리가 있어 OS 테마 기준으로 흑/백이 갈린다(앱 테마와 별개 축) — 무변형 원칙상 후처리로 강제하지 않음, 극단적 조합(라이트 앱+다크 OS 등)에서 대비가 낮아질 수 있는 자산 자체의 한계로 기록. story #3119: tokscale client-pi.png는 실물 대조 결과 earendil-works/pi 실제 마크가 아닌 조잡한 픽셀 "P" 블록이었음(#3092 3단계의 "오인 Pi"—Inflection AI Pi 혼동—재발 의심) — 스왑 보류, 기존 1st-party 자산 유지.' },
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
  // story #3107(#3092 후속, 선생님 지시 2026-08-26) — system-publisher는 사람이 붙이는
  // 코딩 에이전트가 아니라 시스템이 발행한 메시지/기록의 발신 주체(#3103/#3508 QA가
  // registry 밖 실재 값으로 실측). 이전엔 "시스템 내부 정체성이라 라벨 생략" 판정이었으나
  // 선생님이 "생략 대신 Sprintable 자사 심볼로 표기"로 확定 — 2색 브랜드 마크(인디고+시안,
  // globals.css --brand-mark-primary/--brand-mark-accent와 동일 마크).
  //
  // story #3107 delta(유나 design 판정 2026-08-26) — 최초 구현은 `/icon.svg`(파비콘) 원본을
  // 그대로 썼으나, 그 파일은 흰 배경 rect가 baked-in돼 있어 다크 테마 디스크 위에서 밝은
  // 사각 패치가 비치는 결함이 실측 확認됐다. 처방: 자사 자산이라 무변형 제약이 제3자 상표
  // 건과 달리 완화된다는 PO 판단 하, **흰 rect만 제거한 투명 파생판**
  // `connector-icons/sprintable-symbol.svg`를 신설(마크 자체의 path data·색상은 무변형 —
  // diff로 검증 가능). `/icon.svg`(실제 파비콘 라우트) 자체는 불변. 디스크는 다른 mono
  // 아이콘과 동형으로 고정 밝은 배경(colorMode='mono' — 위 필드 독스트링의 "disc:'light'"
  // 케이스, 아이콘 자체는 2색 원본 그대로).
  'system-publisher': { kind: 'icon', asset: '/connector-icons/sprintable-symbol.svg', colorMode: 'mono', sourceNote: '1st-party 파생판: apps/web/src/app/icon.svg(Sprintable 웹 앱 자체의 Next.js app-icon 자산, `/icon.svg` 경로로 서빙)에서 흰 배경 rect만 제거 — 마크(인디고 #42549B+시안 #00A3D1 path data) 자체는 무변형. 유나 design 판정(2026-08-26)으로 다크 테마 배경 패치 결함 처방.' },
};
