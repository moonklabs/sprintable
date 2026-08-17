/**
 * story #2420 AC7 — 사용처 회귀가드. AC3(verify-tint-foreground-contrast.ts)는 globals.css의
 * 토큰 "정의"만 본다 — 컴포넌트 파일은 전혀 안 읽는다. 그래서 실제로 화면에 렌더되는 자리
 * 하나(goals-client.tsx:615의 `text-destructive`)를 `text-foreground`에서 계열색으로 되돌려
 * 봤더니 정의 검사·type-check·lint·해당 vitest 전부 그대로 초록이었다 — "정의가 옳다"와
 * "사용처가 정의를 지킨다"는 서로 다른 사실이고, 지금까지 후자를 재는 자가 없었다.
 *
 * story #2575 AC2 — bg 패턴에 `-bg`(불투명 status 배경, 예 `bg-warning-bg`)를 추가한다.
 * #2960(HITL 승인카드) 헤더 라벨이 정확히 이 모양(`bg-warning-bg` + `text-warning`, 같은
 * className 리터럴)이었는데 이 스캐너가 안 잡았다 — bg 패턴이 `-tint`/`/알파`만 알고
 * `-bg`를 몰랐기 때문. baseline은 이 확장 시점(#2575)에 맞춰 재생성한다(§AC2 결과 참고).
 *
 * 이 스크립트가 세는 것 — 유나의 스윕과 같은 자: 같은 문자열/템플릿 리터럴 안에
 * `bg-<X>-bg`·`bg-<X>-tint` 또는 `bg-<X>/<알파>` 와 `text-<X>`(같은 계열 X)가 함께 있는 자리.
 * X ∈ {destructive, info, success, warning} — #2420 규칙(§본문)이 지금 다루는 네 계열.
 * (primary는 이 스토리의 "네 계열" 표에 없어 대상 밖 — primary-tint는 story #2420 범위
 * 밖이라는 것이 스토리 본문 자체의 판정이다. primary-bg는 애초에 정의되지 않는다.)
 *
 * baseline 방식(story #2093 lint_query_sentinel_direct_calls.py와 동일 계약) — 지금
 * 걸리는 수(이 스캐너 기준 90건, 유나 수동 스윕은 112건 — 아래 ①·baseline 파일 _comment
 * 참조)를 grandfather로 얼리고, 그 밖의 새 자리만 FAIL한다. 이 건수를 지금 고치는 것은
 * 이 스토리의 AC4가 아니라 다음 판이다 — 여기서는 "더 늘지 않는다"만 보장한다.
 *
 * story #2710(2026-08-17) — quote-pairing 정규식(LITERAL_RE) 폐기, TS 컴파일러 API
 * (ts.createSourceFile)로 교체. 근본원인(PR #3165 CI 빨강 추적 중 실측): 정규식은 파일
 * 전체를 「따옴표 짝맞추기」로만 훑어 comment/문자열을 구분 못 한다 — 주석 속 apostrophe
 * 하나(`ⓐ'로`처럼 짝 없는 `'`)가 나오면 그 지점부터 다음 `'`까지(다른 파일이면 파일 끝까지)를
 * 통째로 하나의 "리터럴"로 삼킨다. 이게 오탐(#3165, 무관 코드 뭉치가 우연히 family 쌍을 담아
 * 걸림)으로도, **미탐**(진짜 위반이 «삼킨 리터럴의 여는/닫는 따옴표 그 자체»로 소비돼 리터럴
 * 추출 대상에서 아예 빠짐 — 재현·회귀테스트로 실측 확認)으로도 터진다. 실 파서는 주석을
 * 애초에 토큰화하지 않고(swallow 구조적으로 불가) 각 문자열/템플릿 리터럴의 경계를 escape까지
 * 반영해 정확히 긋는다 — 「막는 쪽(가드)과 하는 쪽(코드)이 같은 걸 본다」의 이 가드판.
 * AC4(가드가 자기 재료를 못 읽으면 빨강) — `ts.createSourceFile`의 내부 `parseDiagnostics`가
 * 비어있지 않으면(문법 오류로 파싱 실패) FAIL로 죽는다(조용한 스킵 금지, #2093 lint 가드와
 * 같은 원칙). 이 가드는 「같은 문자열 리터럴 안의 페어링」만 본다는 스코프 자체는 안 바뀐다 —
 * split-literal(예 `cn('bg-x', cond && 'text-x')`)은 여전히 못 본다(교차-요소는 자매 가드
 * verify-cross-element-tint-text.ts 담당, 위 한계 ①과 동일).
 *
 * 이 가드가 못 잡는 것(반드시 읽어야 하는 한계) —
 *   1) 같은 논리적 className이 cn('bg-x/10', cond && 'text-x')처럼 여러 리터럴로
 *      쪼개져 있으면 이 스크립트는 그 둘을 "같은 자리"로 못 본다(각 리터럴을 독립으로
 *      본다) — 유나의 눈-스윕과 자동 스캔 사이의 알려진 간극이다. ⚠️이 간극은 계열마다
 *      고르지 않다(PO 지적, 2026-08-02 재확認) — destructive는 알파 유틸(`bg-destructive/N`)이
 *      인터랙티브 버튼류(하나의 UI에 rest/hover/focus가 서로 다른 문자열 인자로 쪼개지는
 *      패턴)에 압도적으로 많이 쓰여 이 스캐너가 놓치는 비율이 크다(paired 24건 vs repo
 *      전체 bg-destructive/N 발생 67건) — 반면 warning은 거의 전부 배지류 단일 리터럴이라
 *      이 한계의 영향을 거의 안 받는다(paired 3건 vs 전체 9건). 유나 112 vs 이 스캐너 90의
 *      차이(특히 destructive만 56 vs 31로 크게 갈린 것)가 "알파 유틸을 안 센다"가 아니라
 *      "알파 유틸은 세지만 분리 리터럴은 못 본다"로 설명되는 것이 이 재확認의 결론이다.
 *   2) 동적으로 조립되는 클래스명(`` `text-${color}` ``처럼 변수가 섞인 템플릿)은
 *      리터럴 자체에 family 이름이 문자열로 없으면 못 잡는다.
 *   3) 크기(text-xs 등)를 안 본다 — 정의 검사(AC3)와 마찬가지로 "이 쌍이 존재하는가"만
 *      세지 "몇 px에서 렌더되는가"는 안 잰다. 그래서 baseline 90건 전부가 실제로
 *      미달인지는(작은 글자인지) 이 스크립트가 답하지 않는다 — 유나의 사용처 스윕
 *      (§AC7 세 축)이 답할 자리다.
 *   4) "0건 증가"는 "전부 깨끗"이 아니라 "내가 새로 늘리지 않았다"일 뿐이다 — 민군이
 *      query_sentinel 가드에서 쓴 것과 같은 문장이 여기도 그대로 적용된다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const FAMILIES = ['destructive', 'info', 'success', 'warning'] as const;
export type Family = (typeof FAMILIES)[number];

function familyBgRe(family: Family): RegExp {
  // story #2575 AC2 — `-bg`(불투명 status 배경) 추가. `-bg`가 `-tint`보다 먼저 와도/나중에
  // 와도 매칭엔 무관(교대일 뿐)이지만, `-bg`를 앞에 둔 이유는 스캔 결과 로그에서 그대로
  // 눈에 먼저 띄게 하려는 것 — 판정에는 순서가 영향 없다.
  return new RegExp(`(?<![\\w-])bg-${family}(?:-bg|-tint|/\\d+)(?![\\w-])`);
}

function familyTextRe(family: Family): RegExp {
  return new RegExp(`(?<![\\w-])text-${family}(?![\\w-])`);
}

export interface TintTextHit {
  family: Family;
  literal: string;
}

/** 리터럴 하나(따옴표 안 내용물)에서 같은 계열의 bg-tint/알파 + text-family 쌍을 찾는다. */
export function findTintTextPairs(literal: string): TintTextHit[] {
  const hits: TintTextHit[] = [];
  for (const family of FAMILIES) {
    if (familyBgRe(family).test(literal) && familyTextRe(family).test(literal)) {
      hits.push({ family, literal });
    }
  }
  return hits;
}

export interface Violation {
  file: string;
  line: number;
  family: Family;
  literal: string;
}

/** violation의 안정 키 — 파일+계열+리터럴 내용. 줄 번호는 무관한 편집으로 흔들리므로
 * (query_sentinel 가드와 같은 이유) 키에서 제외한다. */
export function violationKey(v: Pick<Violation, 'file' | 'family' | 'literal'>): string {
  return `${v.file}::${v.family}::${v.literal}`;
}

/** node가 문자열/템플릿 리터럴이면 그 "리터럴 텍스트"를 하나로 뽑는다(정적 부분만 —
 * 보간식 `${expr}` 내부의 개별 문자열은 이 함수가 아니라 AST 재귀 자체가 따로 방문한다,
 * 그래서 `` `${cond ? "text-x" : "text-y"}` `` 안의 "text-x"도 독립 리터럴로 잡힌다). */
function literalTextOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((sp) => sp.literal.text)].join(' ');
  }
  return null;
}

export function scanContent(content: string, file: string): Violation[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // AC4 — 가드가 자기 재료(이 파일)를 못 읽으면(문법 오류로 파싱 실패) 조용히 건너뛰지 않고
  // 죽는다. parseDiagnostics는 공개 타입엔 없지만 컴파일러가 실제로 채우는 필드 — #2590
  // verify-cross-element-tint-text.ts와 이 가드가 함께 의존하는 ts.createSourceFile의 오래된
  // 안정 동작이다(빈 배열=클린 파싱, 실측 확認).
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    throw new Error(
      `FAIL: ${file} 파싱 실패(${parseDiagnostics.length}건) — 이 가드가 이 파일의 문자열 리터럴을 ` +
        `못 읽는다(재료 소실을 조용한 통과로 두지 않는다, story #2710 AC4): ` +
        parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    );
  }

  const violations: Violation[] = [];
  function walk(node: ts.Node): void {
    const literal = literalTextOf(node);
    if (literal !== null) {
      const hits = findTintTextPairs(literal);
      if (hits.length > 0) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        for (const hit of hits) {
          violations.push({ file, line, family: hit.family, literal: hit.literal });
        }
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return violations;
}

const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.test\.[tj]sx?$/;
const MIN_EXPECTED_FILES = 500;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

export function scanRepo(srcRoot: string): Violation[] {
  const files: string[] = [];
  walk(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 파일이 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const violations: Violation[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    violations.push(...scanContent(content, rel));
  }
  return violations;
}

const BASELINE_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'tint-color-text-baseline.json');

// JSON 배열로 저장한다 — 플레인 텍스트 줄 단위(query_sentinel_baseline.txt와 같은 방식)로
// 하려 했으나, 여기 키에 들어가는 리터럴은 (`cage/gate-line-context.tsx:82`처럼) 삼항식을
// 품은 템플릿 리터럴이라 실제 개행 문자를 포함할 수 있다 — 줄 단위 포맷은 그 개행에서
// 키 하나가 여러 "줄"로 쪼개져 baseline이 부풀고(실측: 87개를 296개로 오염) 매칭이 깨진다.
// JSON 배열은 문자열 안 개행을 이스케이프해 저장하므로 이 문제가 구조적으로 없다.
export function loadBaseline(filePath: string): Set<string> {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { keys: string[] };
    return new Set(parsed.keys);
  } catch {
    return new Set();
  }
}

function main(): number {
  const srcRoot = path.resolve(process.cwd(), 'src');
  const violations = scanRepo(srcRoot);
  const baseline = loadBaseline(BASELINE_PATH);

  const newViolations = violations.filter((v) => !baseline.has(violationKey(v)));
  const grandfathered = violations.filter((v) => baseline.has(violationKey(v)));

  console.log(`grandfathered baseline: ${baseline.size}건`);
  console.log(
    `검출 ${violations.length}건(baseline 기존 ${grandfathered.length}건 + 신규 ${newViolations.length}건) ` +
      `— family별: ${FAMILIES.map((f) => `${f} ${violations.filter((v) => v.family === f).length}`).join(' · ')}`,
  );

  if (newViolations.length > 0) {
    console.error('\nFAIL: baseline에 없는 새 tint-배경×계열색-글자 자리 발견(story #2420 AC7 회귀):');
    for (const v of newViolations) {
      console.error(`  ${v.file}:${v.line} [${v.family}] "${v.literal}"`);
    }
    console.error(
      '\ntint 계열 배경 위 글자는 계열색이 아니라 text-foreground를 쓴다(story #2420 규칙). ' +
        '새 자리가 필요하면 이 규칙을 따르거나, 색 자체가 데이터인 예외라면 실물을 들고 PO 승인을 받는다.',
    );
    return 1;
  }

  if (grandfathered.length > 0) {
    console.log(`\n(참고) baseline grandfather ${grandfathered.length}건은 실패시키지 않음 — 개별 수리는 이 스토리(AC4류 후속)의 몫이 아니다:`);
  }

  console.log('\nOK: 새 tint-배경×계열색-글자 자리 0건(baseline 초과 없음 — "전부 깨끗"이 아니라 "안 늘었다"는 뜻).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    // story #2710 — verify-cross-element-tint-text.ts와 같은 재생성 방식(can-only-shrink
    // 메타가드 없음, 위 baseline 파일 _comment의 재키잉 전례들과 동일 계약).
    const violations = scanRepo(path.resolve(process.cwd(), 'src'));
    const keys = [...new Set(violations.map(violationKey))].sort();
    process.stdout.write(JSON.stringify({ _comment: [], keys }, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
