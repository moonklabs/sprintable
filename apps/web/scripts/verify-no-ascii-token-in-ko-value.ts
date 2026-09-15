/**
 * story #3880(§⑤ 낱말 드리프트) AC2(b) — verify-no-raw-ascii-jsx-text.ts(story #3876,
 * JSX 구조를 본다)의 자매 가드지만 축이 다르다: 이건 **i18n 값 콘텐츠**를 본다. 실 사고:
 * `docs.indexKicker`="지식 · KNOWLEDGE BASE"는 `t('indexKicker')`로 정상 경유하는데
 * (구조는 무결) ko.json 값 자체에 영단어가 baked-in — 키 존재·t() 경유 검사로는
 * 원리상 못 잡는 클래스(어떤 JSX 구조 가드도 값 안을 안 본다).
 *
 * ## 기전 — messages/ko.json을 재귀 순회, 모든 leaf 문자열 값에서 `\b[A-Z]{2,}\b`(대문자
 * 2자 이상 토큰) 검출. en.json은 대상 밖(원문이 영어라 당연히 대문자 토큰이 있다 —
 * ko 로케일에서만 "영단어가 샌다"는 문제가 성립).
 *
 * ## 축 2 — story #3880 CHANGES②(PO PR 코멘트, 2026-09-14 16:13Z)
 * 위 CAPS_TOKEN_RE 축은 대문자 토큰만 봐서 Title-Case 값("Queued"·"Needs input"·
 * "Claimed done" 같은 pipeline 6값)은 구조적으로 못 본다 — 카드 AC2(b) 14:45Z 부기가
 * 요구한 «값 전체가 순 ASCII 단어» 축이 미이행이었던 것을 PO가 실측 지적(이 PR에서 고친
 * pipeline 값을 되돌려도 CAPS 축만으로는 GREEN이었다). 별도 축 추가: 값 전체(trim)가
 * 공유 술어 `isUntranslatedCopy()`(scripts/lib/is-untranslated-copy.ts, 3876·3880(a)
 * 가드와 동일 기준)에 매칭하면 위반. CAPS 축과 독립 — 각자 자기 ALLOWLIST/baseline을 쓴다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUntranslatedCopy } from './lib/is-untranslated-copy';

export interface AsciiTokenRef {
  key: string;
  value: string;
  token: string;
}

const CAPS_TOKEN_RE = /\b[A-Z]{2,}\b/g;

function flatten(obj: Record<string, unknown>, prefix: string, out: Map<string, string>): void {
  for (const [k, v] of Object.entries(obj)) {
    const qualifiedKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v as Record<string, unknown>, qualifiedKey, out);
    } else if (typeof v === 'string') {
      out.set(qualifiedKey, v);
    }
  }
}

export function scanKoValues(koJson: Record<string, unknown>): AsciiTokenRef[] {
  const flat = new Map<string, string>();
  flatten(koJson, '', flat);

  const refs: AsciiTokenRef[] = [];
  for (const [key, value] of flat) {
    const matches = value.match(CAPS_TOKEN_RE);
    if (!matches) continue;
    for (const token of new Set(matches)) {
      refs.push({ key, value, token });
    }
  }
  return refs;
}

/** ref의 안정 키 — i18n 키+토큰(값 전체가 아니라 — 값의 다른 부분이 바뀌어도 같은
 * 토큰이 남아있으면 같은 자리로 식별). */
export function refKey(r: Pick<AsciiTokenRef, 'key' | 'token'>): string {
  return `${r.key}::${r.token}`;
}

// ALLOWLIST — 영구 예외(§⑤ 허용 액센트). 키 단위(key::token) — 이 특정 자리에서만
// 허용되는, 자리에 종속된 디자인 의도(브랜드/기술 식별자와 다름 — TOKEN_ALLOWLIST 참조).
// story #3880 PO 確定(2026-09-14 15:47Z) — 목표 상세 eyebrow 3 + 목표 목록 킥커는
// "한국어 낱말 · 영문 대문자 proof-단계 스탬프" 패턴이 §⑤가 허용하는 액센트(증명 시스템
// 시그니처, 내부어 누출 아님) — 3880 스코프 밖, 변경 0.
export const ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'goals.taskCapsuleTitle::CLAIMED',
  'goals.outcomeCapsuleTitle::VERIFIED',
  'goals.trustRailTitle::TRUST',
  'goals.indexKicker::OUTCOMES',
]);

// story #3880 CHANGES③(PO PR 코멘트, 2026-09-14 16:13Z) — 기존 baseline 242건이 영구
// 기술 식별자(어느 키에 나오든 항상 무해)와 잔존 드리프트(개별 판단 필요·번역 후보)를
// 구분 없이 섞어 "더 늘지 않는다"만 보장하고 있어 stale 규칙이 뜻을 못 가른다는 PO 지적
// — 토큰 «단위» ALLOWLIST(어느 키든 이 토큰이면 항상 허용, 사유 1줄)로 분리. baseline은
// 이제 "이 토큰은 개별 판단 필요·아직 안 봄"만 남는다(전량 정리는 후속 별건, 여기 있는
// 건 fix 대상 확定 아님).
//
// 분류 근거(그라운딩 — 각 토큰의 실제 값 문맥을 messages/ko.json에서 직접 대조):
//  - 프로토콜/파일형식/단위/표준 이니셜리즘(브랜드·낱말 선택 여지 없음, 어느 언어든
//    번역 대상이 아님): API·AI·URL·MCP·ID·SSE·UTM·HTML·JSON·LLM·CI·SHA·DM·STT·CSV·
//    SLA·PDF·HTTP·AC·SDK·HTTPS·POST·PC·UI·PNG·OS·CTA·SNS·GB·SSO·TOTP·QR·MB·PR —
//    실측: "PR 리뷰"·"CI · 납품"·"AC {met}/{total} 충족"·"웹 UI 사용"·"PC 화면에서만"·
//    "SNS에 나가는 글"·"우선 큐 · SSO" 등 전부 Korean 문장 안에 자연 삽입된 기술 용어
//    (§⑤ 대상인 "말투/낱말"이 아니라 업계 공통 이니셜리즘).
//  - 이 제품 자체의 고유 기능명(coined term, 브랜드명과 동형): BYOA·BYOM·BYO(Bring
//    Your Own *) — flow.guidedExampleByoa="BYOA 채택" 등, 기능 고유명사.
//  - board.backlinksExcludePrSid="PR/커밋의 [SID:XXX] 텍스트 관례"의 SID·XXX — 이
//    프로젝트 자체 PR 제목 관례([SID:XXX], CLAUDE.md에 명문화)를 설명하는 플레이스홀더
//    표기 — 번역 대상 낱말이 아니라 구문 표기.
//
// story #3922(§⑤ 낱말 드리프트 전량 정리) — 위 34건 잔존분을 PO 判定으로 전량 종결:
//  - QA·PO·PM(·DevOps, 축2 전용) — 조직 role-badge 패밀리(trustRoleLabelQa/Po·
//    stageRoleLabelQa/Po·onboarding.roleQa/Pm/Devops 등). PO 判定(2026-09-15):
//    "Sprintable 자체 역할 식별자·한국어 역할 낱말 체계 없음" — 번역 대상 아니라
//    토큰 단위 허용으로 이관.
//  - AU — "자동화" 병기 中(billing.auPausedDesc/auWarn90Desc/auWarnDesc 3곳 모두
//    "자동화(AU)"·"자동화 사용량(AU)" 형태로 이미 병기) — PO 判定(AU는 자동화 병기
//    中이면 허용)에 따라 허용. billing.auUsage(압축 게이지 라벨, 같은 섹션의 병기
//    재사용)도 동일 취급.
//  - DASHBOARD·STATUS·ALL·CLEAR·OPERATOR·USAGE — 전부 §⑤ 확定 뒤 처리 완료:
//    agents.statusEyebrow(STATUS DASHBOARD)·usage.eyebrow(OPERATOR USAGE)는 실
//    소비처 0(grep 확認) — 삭제. attentionQueue.allClear(ALL CLEAR)는 "안전"으로
//    한국어 전환 — 이 4토큰은 값 자체가 사라져 baseline/ALLOWLIST 어디에도 안 남음.
//  - PM·CORE·STEER·PRD — PM은 역할 패밀리(위)로 허용. CORE(recruiter.scopeCore→
//    "핵심")·STEER(chats.steerToggleLabel의 중복 "(STEER)" 접미사 제거 — "방향
//    전환"만 남김)·PRD(canvas.descriptionPaneHeading→"문서")는 §⑤ 확定대로 한국어
//    전환 — 값이 사라져 이 축엔 안 남음.
export const TOKEN_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'API', 'AI', 'URL', 'MCP', 'ID', 'SSE', 'UTM', 'HTML', 'JSON', 'LLM', 'CI', 'SHA', 'DM',
  'BYOA', 'STT', 'CSV', 'SLA', 'PDF', 'HTTP', 'SDK', 'HTTPS', 'POST', 'BYOM', 'PC',
  'UI', 'SID', 'XXX', 'PNG', 'OS', 'CTA', 'SNS', 'GB', 'SSO', 'BYO', 'TOTP', 'QR', 'MB', 'PR',
  'QA', 'PO', 'PM', 'AU',
]);

// ---------------------------------------------------------------------------
// 축 2 — story #3880 CHANGES② — 값 전체가 순수 미번역 카피인 경우(부분 토큰 아님).
// ---------------------------------------------------------------------------

export interface WholeValueAsciiRef {
  key: string;
  value: string;
}

export function scanKoWholeValues(koJson: Record<string, unknown>): WholeValueAsciiRef[] {
  const flat = new Map<string, string>();
  flatten(koJson, '', flat);

  const refs: WholeValueAsciiRef[] = [];
  for (const [key, value] of flat) {
    if (isUntranslatedCopy(value.trim())) {
      refs.push({ key, value });
    }
  }
  return refs;
}

/** 축 2의 안정 키 — i18n 키(값 전체가 단위라 토큰 성분 불필요, 축 1의 refKey와 구분). */
export function wholeValueRefKey(r: Pick<WholeValueAsciiRef, 'key'>): string {
  return r.key;
}

// 축 2 전용 ALLOWLIST — 키 단위(값이 아니라 키, wholeValueRefKey 참조 — 같은 값이
// 여러 키에 반복돼도 키마다 등재 필요). story #3922(§⑤ 낱말 드리프트 전량 정리)가
// baseline 69건을 분류해 이관 — 각 그룹 사유는 PO 判定(2026-09-15) 그대로.
export const WHOLE_VALUE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // 채널 브랜드명(제3자 서비스 고유명사, 번역 대상 아님) — channelConnect·content·
  // organization 3개 네임스페이스에 동일 브랜드 라벨이 반복(각 표면이 독립 소비처).
  'channelConnect.channelLabelFacebook', 'channelConnect.channelLabelGhost',
  'channelConnect.channelLabelGhostSandbox', 'channelConnect.channelLabelInstagram',
  'channelConnect.channelLabelWordpress', 'channelConnect.channelLabelYoutube',
  'channelConnect.channelThreads',
  'content.channelLabelFacebook', 'content.channelLabelGhost',
  'content.channelLabelGhostSandbox', 'content.channelLabelInstagram',
  'content.channelLabelWordpress', 'content.channelLabelYoutube', 'content.channelThreads',
  'organization.channelLabelFacebook', 'organization.channelLabelGhost',
  'organization.channelLabelGhostSandbox', 'organization.channelLabelInstagram',
  'organization.channelLabelWordpress', 'organization.channelLabelYoutube',
  'organization.channelThreads',

  // 제품/플랫폼 고정 식별자(PO 명시 카테고리 (b) — MCP Config·GitHub App·Webhook URL·
  // CI) 및 그 동류(App ID·App Secret·HTML 파일형식) — 번역하면 실제 설정 화면·API
  // 필드명과 어긋난다.
  'channelConnect.appCredentialsAppIdLabel', 'channelConnect.appCredentialsAppSecretLabel',
  'onboarding.mcpConfigTitle', 'recruiter.equipMcpConfigLabel', 'settings.agentMcpTitle',
  'settings.agentWebhookTitle', 'settings.ghAppTitle', 'docs.formatHtml',

  // 이니셜리즘(축1 TOKEN_ALLOWLIST와 동일 근거 — 프로토콜/표준/외부 도구 고유명, 자리별
  // 판단 불필요) — 축2(전체값)는 별도 baseline이라 키마다 재등재 필요.
  'cage.ciLabel', 'cage.githubCheckLabel', 'chats.dmSection', 'chats.dmWith',
  'hypotheses.sourceGa4', 'verify.evidenceTypePr',

  // 이 제품 자체의 고유명(로그인 화면 타이틀 "Sprintable"·AI 부속 라벨 "Sprintable AI") —
  // 브랜드명과 동형, ko/en 항상 동일 유지.
  'login.title', 'loops.aiAttributionLabel',

  // UTM 파라미터명(PO 카테고리 (c) — content/medium/source, 프로토콜 자체의 소문자
  // 고정 파라미터, 번역하면 실제 URL 쿼리스트링과 어긋난다).
  'contentRules.utmRulesStatusContent', 'contentRules.utmRulesStatusMedium',
  'contentRules.utmRulesStatusSource',

  // 요금제 티어명(PO 카테고리 (e) — Free/Starter/Team/Business, 결제 시스템 실제
  // plan_id와 동형인 고유 플랜명, 번역 대상 아님).
  'pricingPlans.tierName_business', 'pricingPlans.tierName_free',
  'pricingPlans.tierName_starter', 'pricingPlans.tierName_team',

  // 조직 role-badge 패밀리(PO 判定 — "Sprintable 자체 역할 식별자·한국어 역할 낱말
  // 체계 없음") — 축1 TOKEN_ALLOWLIST의 QA/PO/PM과 축2 전용 DevOps(대문자 2자+
  // 아니라 축1에 안 걸림, 같은 패밀리).
  'dashboard.ccGateTypeQa', 'onboarding.roleDevops', 'onboarding.rolePm',
  'onboarding.roleQa', 'organization.stageRoleLabelPo', 'organization.stageRoleLabelQa',
  'organization.trustRoleLabelDevops', 'organization.trustRoleLabelPo',
  'organization.trustRoleLabelQa',

  // 이 제품 자체의 고유 기능명(coined term, 축1의 BYOA/BYOM/BYO와 동일 패밀리) —
  // agentRuns.billingMode_managed(대응짝)는 일반 영단어라 "관리형"으로 한국어 전환.
  'agentRuns.billingMode_byom',
]);

const WHOLE_VALUE_BASELINE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'ascii-whole-value-in-ko-value-baseline.json',
);

export function computeNewWholeValueViolations(
  refs: WholeValueAsciiRef[],
  allowlist: ReadonlySet<string>,
  baseline: ReadonlySet<string>,
): WholeValueAsciiRef[] {
  return refs.filter((r) => {
    const key = wholeValueRefKey(r);
    return !allowlist.has(key) && !baseline.has(key);
  });
}

export function computeStaleWholeValueBaseline(refs: WholeValueAsciiRef[], baseline: ReadonlySet<string>): string[] {
  const foundKeys = new Set(refs.map(wholeValueRefKey));
  return [...baseline].filter((k) => !foundKeys.has(k));
}

const KO_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'ascii-token-in-ko-value-baseline.json');

interface BaselineFile {
  _comment: string[];
  keys: string[];
}

export function loadBaseline(filePath: string): Set<string> {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    return new Set(parsed.keys ?? []);
  } catch {
    return new Set();
  }
}

// story #3880 CHANGES③ — tokenAllowlist는 선택 인자(하위호환: 생략하면 기존 2-인자
// 호출부·테스트가 그대로 동작). 넘기면 토큰(어느 키든) 단위로도 걸러낸다.
export function computeNewViolations(
  refs: AsciiTokenRef[],
  allowlist: ReadonlySet<string>,
  baseline: ReadonlySet<string>,
  tokenAllowlist: ReadonlySet<string> = new Set(),
): AsciiTokenRef[] {
  return refs.filter((r) => {
    const key = refKey(r);
    return !allowlist.has(key) && !baseline.has(key) && !tokenAllowlist.has(r.token);
  });
}

export function computeStaleBaseline(refs: AsciiTokenRef[], baseline: ReadonlySet<string>): string[] {
  const foundKeys = new Set(refs.map(refKey));
  return [...baseline].filter((k) => !foundKeys.has(k));
}

/** TOKEN_ALLOWLIST 안 죽은 항목(더는 ko.json 어디에도 안 나오는 토큰) 탐지 —
 * baseline의 stale 개념과 동형이지만 토큰 단위. */
export function computeStaleTokenAllowlist(refs: AsciiTokenRef[], tokenAllowlist: ReadonlySet<string>): string[] {
  const foundTokens = new Set(refs.map((r) => r.token));
  return [...tokenAllowlist].filter((t) => !foundTokens.has(t));
}

const MIN_EXPECTED_KEYS = 3000;

export function loadKoJson(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function main(): number {
  let koJson: Record<string, unknown>;
  try {
    koJson = loadKoJson(KO_JSON_PATH);
  } catch (e) {
    console.error(`FAIL: messages/ko.json을 못 읽음 — ${(e as Error).message}`);
    return 1;
  }

  const flatCount = (() => {
    const m = new Map<string, string>();
    flatten(koJson, '', m);
    return m.size;
  })();
  if (flatCount < MIN_EXPECTED_KEYS) {
    console.error(`FAIL: ko.json에서 leaf 문자열 키가 ${flatCount}개뿐 — 이 가드가 헛돌고 있다.`);
    return 1;
  }

  const refs = scanKoValues(koJson);
  const baseline = loadBaseline(BASELINE_PATH);

  const newViolations = computeNewViolations(refs, ALLOWLIST, baseline, TOKEN_ALLOWLIST);
  const refsNotInKeyAllowlist = refs.filter((r) => !ALLOWLIST.has(refKey(r)) && !TOKEN_ALLOWLIST.has(r.token));
  const staleBaseline = computeStaleBaseline(refsNotInKeyAllowlist, baseline);
  const staleTokenAllowlist = computeStaleTokenAllowlist(refs, TOKEN_ALLOWLIST);

  console.log(
    `[story #3880 AC2(b) 축1-CAPS] ko.json 값 콘텐츠 순 ASCII 대문자 토큰 스캔 — leaf 키 ${flatCount}개 · ` +
      `검출 ${refs.length}건 · 키단위 ALLOWLIST ${ALLOWLIST.size}건 · 토큰단위 TOKEN_ALLOWLIST ${TOKEN_ALLOWLIST.size}개 · ` +
      `baseline(잔존·개별판단필요) ${baseline.size}건 · 신규 ${newViolations.length}건 · stale ${staleBaseline.length}건`,
  );

  let failed = false;

  if (newViolations.length > 0) {
    failed = true;
    console.error('\nFAIL: ALLOWLIST/baseline에 없는 ko.json 값 안 순 ASCII 대문자 토큰 발견:');
    for (const r of newViolations.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${r.key}="${r.value}" (토큰: ${r.token})`);
    }
    console.error(
      '\n→ 한국어 낱말로 옮길 것 — 새 낱말이 필요하면 §⑤ 낱말 표를 먼저 확定(유나) 한 뒤 반영. ' +
        '정말 영구 기술 식별자면(프로토콜·파일형식·단위 등, 어느 키든) TOKEN_ALLOWLIST에 사유와 함께 등재(PO 승인), ' +
        '특정 자리 디자인 의도면(§⑤ 액센트 등) ALLOWLIST에 등재(PO 승인), ' +
        '이 카드 스코프 밖이면 baseline에 등재(PO 승인).',
    );
  }

  if (staleBaseline.length > 0) {
    failed = true;
    console.error(`\nFAIL: baseline(축1-CAPS)에 ${staleBaseline.length}건이 등재됐으나 이번 스캔에서 안 걸렸다:`);
    for (const k of staleBaseline.sort()) console.error(`  - ${k}`);
    console.error('\n→ 고쳐졌다면(한국어로 옮겼거나 삭제했다면) baseline에서 그 항목을 지울 것.');
  }

  if (staleTokenAllowlist.length > 0) {
    failed = true;
    console.error(`\nFAIL: TOKEN_ALLOWLIST에 ${staleTokenAllowlist.length}개 죽은 토큰(ko.json 어디에도 안 나옴):`);
    for (const t of staleTokenAllowlist.sort()) console.error(`  - ${t}`);
    console.error('\n→ TOKEN_ALLOWLIST에서 그 토큰을 지울 것.');
  }

  // 축 2 — story #3880 CHANGES② — 값 전체 순 ASCII 단어(공유 술어).
  const wholeValueRefs = scanKoWholeValues(koJson);
  const wholeValueBaseline = loadBaseline(WHOLE_VALUE_BASELINE_PATH);
  const newWholeValueViolations = computeNewWholeValueViolations(wholeValueRefs, WHOLE_VALUE_ALLOWLIST, wholeValueBaseline);
  const staleWholeValueBaseline = computeStaleWholeValueBaseline(
    wholeValueRefs.filter((r) => !WHOLE_VALUE_ALLOWLIST.has(wholeValueRefKey(r))),
    wholeValueBaseline,
  );

  console.log(
    `[story #3880 AC2(b) 축2-전체값] ko.json 값 콘텐츠 순 ASCII 단어(값 전체) 스캔 — ` +
      `검출 ${wholeValueRefs.length}건 · ALLOWLIST ${WHOLE_VALUE_ALLOWLIST.size}건 · ` +
      `baseline(grandfather) ${wholeValueBaseline.size}건 · 신규 ${newWholeValueViolations.length}건 · ` +
      `stale ${staleWholeValueBaseline.length}건`,
  );

  if (newWholeValueViolations.length > 0) {
    failed = true;
    console.error('\nFAIL: ALLOWLIST/baseline에 없는 ko.json 값 전체 순 ASCII 단어 발견(CAPS 아니어도 잡힘):');
    for (const r of newWholeValueViolations.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${r.key}="${r.value}"`);
    }
    console.error(
      '\n→ 한국어 낱말로 옮길 것 — 새 낱말이 필요하면 §⑤ 낱말 표를 먼저 확定(유나) 한 뒤 반영. ' +
        '정말 번역 대상이 아니면(브랜드·식별자 등) WHOLE_VALUE_ALLOWLIST에 사유와 함께 등재(PO 승인), ' +
        '이 카드 스코프 밖이면 baseline에 등재(PO 승인).',
    );
  }

  if (staleWholeValueBaseline.length > 0) {
    failed = true;
    console.error(`\nFAIL: baseline(축2-전체값)에 ${staleWholeValueBaseline.length}건이 등재됐으나 이번 스캔에서 안 걸렸다:`);
    for (const k of staleWholeValueBaseline.sort()) console.error(`  - ${k}`);
    console.error('\n→ 고쳐졌다면(한국어로 옮겼거나 삭제했다면) baseline에서 그 항목을 지울 것.');
  }

  if (failed) return 1;

  console.log('\nOK: ALLOWLIST/baseline 초과 없음(신규 0건) · stale 0건(죽은 baseline 항목 없음) — 축1·축2 둘 다.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const koJson = loadKoJson(KO_JSON_PATH);
    const refs = scanKoValues(koJson).filter((r) => !ALLOWLIST.has(refKey(r)) && !TOKEN_ALLOWLIST.has(r.token));
    const keys = [...new Set(refs.map(refKey))].sort();
    const out: BaselineFile = {
      _comment: [
        'story #3880(§⑤ 낱말 드리프트) CHANGES③ 재구성(2026-09-14) — 영구 기술 식별자는',
        'TOKEN_ALLOWLIST로 분리됐다(verify-no-ascii-token-in-ko-value.ts 본문 주석 참조).',
        '여기 남은 건 "개별 판단 필요·§⑤ 확定 전" 잔존 드리프트뿐(SP·QA·PO·WIP·AU 등) —',
        '전량 정리는 후속 별건. "더 늘지 않는다"만 보장.',
      ],
      keys,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else if (process.argv.includes('--write-baseline-whole-value')) {
    const koJson = loadKoJson(KO_JSON_PATH);
    const refs = scanKoWholeValues(koJson).filter((r) => !WHOLE_VALUE_ALLOWLIST.has(wholeValueRefKey(r)));
    const keys = [...new Set(refs.map(wholeValueRefKey))].sort();
    const out: BaselineFile = {
      _comment: [
        'story #3880(§⑤ 낱말 드리프트) CHANGES② grandfather baseline — 축2(값 전체 순 ASCII',
        '단어) 첫 도입 시점(pipeline 6값 fix 後) develop의 기존 잔존분(브랜드·역할약어·채널명 등,',
        '이 카드 스코프 밖 — 개별 판단 필요, 전량 정리는 후속 별건). "더 늘지 않는다"만 보장.',
      ],
      keys,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
