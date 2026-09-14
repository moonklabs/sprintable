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
// 分類 밖(baseline에 잔존 — PO가 명시한 SP·PO·WIP·AU와 같은 급, 개별 판단 필요):
//  - SP·QA·PO·WIP·AU — QA·PO는 조직 role-badge 패밀리(trustRoleLabelQa/Po 등)로
//    PO 자신(PO 토큰)을 드리프트로 명시했으므로 같은 패밀리인 QA도 동일 취급(자리마다
//    §⑤ 낱말 확定 필요할 수 있음 — 추측 금지).
//  - DASHBOARD·STATUS·ALL·CLEAR·OPERATOR·USAGE — 이니셜리즘 아닌 평범한 영단어(대문자
//    스탬프 문구), 축2(전체값)에도 이미 걸리는 자리 — §⑤ 확定 대상.
//  - PM·CORE·STEER·PRD — 브랜드/디자인 의도 애매(예: STEER는 "방향 전환(STEER)"처럼
//    §⑤ 허용 액센트 패턴과 유사해 보이나 PO/유나 확定 없이 단정 금지).
export const TOKEN_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'API', 'AI', 'URL', 'MCP', 'ID', 'SSE', 'UTM', 'HTML', 'JSON', 'LLM', 'CI', 'SHA', 'DM',
  'BYOA', 'STT', 'CSV', 'SLA', 'PDF', 'HTTP', 'AC', 'SDK', 'HTTPS', 'POST', 'BYOM', 'PC',
  'UI', 'SID', 'XXX', 'PNG', 'OS', 'CTA', 'SNS', 'GB', 'SSO', 'BYO', 'TOTP', 'QR', 'MB', 'PR',
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

// 축 2 전용 ALLOWLIST — 브랜드/식별자 사유(§⑤ 허용 액센트와 별개, story #3880 스코프
// 안에서 확認된 것만). 현재 비어있음 — 신규 항목은 PO 승인 후 사유 1줄과 함께 등재.
export const WHOLE_VALUE_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

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
