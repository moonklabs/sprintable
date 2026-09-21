/**
 * story #4079(까디르 #4077 스캔 §4-4 처방, 2026-09-21) — apps/web엔 하드코드 절대 일시
 * 리터럴이 실 `Date.now()`류와 부딪혀 특정 달력일에 결과가 뒤집히는 「시한폭탄」 클래스를
 * 막는 가드가 전혀 없었다(52개 verify:* 중 0개, #4077 문서 §4-2). #4453(PR #4453,
 * channel-posts page.test.tsx:2503) 실사고 — `scheduled_at: '2026-09-20T00:00:00Z'`가
 * `use-reset-passed.ts`의 `Date.now()` 비교(테스트 파일이 아니라 렌더되는 컴포넌트/훅
 * 쪽)와 부딪혀 오늘 UTC 자정을 지나며 develop 전체가 RED됐다 — 이 가드가 그 재발을 막는다.
 *
 * ## 판정 단위 — describe/it/test 콜백(가장 가까운 함수), 못 찾으면 모듈 전체.
 * BE 자매 가드(backend/scripts/lint_no_hardcoded_iso_timestamp.py::scan_tests_source)와
 * 동일 사상(같은 실측 과정 — 함수 단위로 좁혀야 순수 픽스처 팩토리가 무관한 다른 테스트의
 * `Date.now()` 호출 때문에 오탐되지 않는다).
 *
 * ## 「위험대」 리터럴 — ISO 문자열(`20YY-MM-DDT...`)과 `new Date(2026, ...)` 생성자
 * 스타일 둘 다, 연도가 sentinel 밖(2022~2089)일 때만.
 *
 * ## 게이트 2단 — ①이 스코프에 실 `Date.now()`/인자 없는 `new Date()` 호출이 있으면
 * 위험(다수 순수 픽스처·표시용 값을 통과시키는 1차 게이트, BE와 동형) ②**필드명 우회**:
 * `scheduled_at`/`sealed_scheduled_at`류 알려진 시각-비교 민감 필드(TEMPORAL_FIELD_NAMES)의
 * 값이면 ①과 무관하게 항상 위험 취급한다 — #4453 원 사고가 정확히 이 모양(테스트 파일
 * 자신엔 `Date.now()` 호출이 없다, 비교는 다른 모듈에 있다)이라 ①만으로는 못 잡는다.
 *
 * ## 안전 신호(둘 중 하나로 위험을 벗는다)
 * - sentinel 연도(<=2021·>=2090, BE와 동형)
 * - freeze/DI 관용구: `vi.setSystemTime(...)`·`vi.spyOn(Date, 'now')`·`vi.useFakeTimers(...)`
 *   가 같은 스코프에 있거나, 리터럴이 now/today/current/frozen/as_of/fixed_now류 이름
 *   (밑줄 접두 허용, `FIXED_NOW`가 정확히 이 관용구 — 스토리 설명 "고정 시각(vi.setSystemTime/
 *   FIXED_NOW) 픽스처는 통과" 그대로)으로 대입되는 자리.
 *
 * ALLOWLIST(file+line+literal, 사유 필수) — #4077 문서가 실측으로 안전을 확認했는데 위
 * 휴리스틱의 사각에 걸리는 개별 자리만.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.(tsx?|ts)$/;
// 2026-09-21 실측(story #4079 착수 시점) apps/web/src .ts/.tsx 전체(테스트 포함) 2013파일.
const MIN_EXPECTED_FILES = 1800;

const ISO_TIMESTAMP_YEAR_RE = /\b(20\d\d)-\d\d-\d\dT/;
const SENTINEL_PAST_MAX_YEAR = 2021;
const SENTINEL_FUTURE_MIN_YEAR = 2090;
const DI_NAME_RE = /^_*(now|today|current|frozen|as_of|fixed_now)/i;

// story #4079 §4-4 처방 — #4453 원 사고와 동일 계열(시각 비교에 직접 쓰이는 필드).
// 새 필드를 추가하려면 실제로 「값이 live-now류와 비교/파생되는지」를 코드에서 확認할 것
// (이름만 비슷해 보인다고 등재하지 않는다 — HANJA_EXCEPTIONS류 사유 필수 원칙과 동형).
const TEMPORAL_FIELD_NAMES = new Set([
  'scheduled_at', 'scheduledAt',
  'sealed_scheduled_at', 'sealedScheduledAt',
  // ⛔'expires_at'/'expiresAt'는 실측 결과 제외 — apps/web/src에 선언만 있고(avatar-
  // upload.ts·storage-upload.ts 타입 필드) 어디서도 Date.now()류와 비교되지 않는다
  // (presigned-URL 응답의 순수 표시/전달 필드).
  // ⛔'next_run_at'/'nextRunAt'도 실측 결과 제외 — recurring-recipes-section.tsx가
  // `formatScheduledAt`(절대포맷 전용, #4077 문서 §AC2 (c) 5 부류)로만 쓰고, repeat-
  // schedules 4개 route.test.ts는 BFF 프록시 pass-through 테스트(응답을 그대로
  // 전달하는지만 확인, #4077 문서 §AC2 (c) 2 부류 mock-echo)라 비교 로직에 안 닿는다.
  // 등재 전 실사용 확認 원칙(위 docstring) 그대로 뺀다 — 이름만 비슷해 보여 등재했다가
  // 6개 파일을 오탐시킨 실사례.
]);

export interface Violation {
  file: string;
  line: number;
  text: string;
}

export interface AllowlistEntry {
  file: string;
  line: number;
  text: string;
  reason: string;
}

// story #4079 — 실측으로 안전을 확認한 개별 사각(사유 필수, 말없는 예외 금지).
export const ALLOWLIST: AllowlistEntry[] = [
  {
    file: 'components/hypotheses/hypothesis-row.test.tsx', line: 38, text: '2026-08-01T00:00:00Z',
    reason: 'hypothesis() 픽스처 팩토리의 measure_after — 같은 함수의 created_at/updated_at이 `new Date()`(인자 0개)를 써 함수 단위 live-now 게이트를 통과시켰을 뿐, measure_after 자신은 hypothesis-row.tsx에서 .slice(0,10) 표시용(Date 파싱조차 안 함, #4077 문서 §AC2 (c) 5 실측).',
  },
  // scheduled_at 표시/그룹핑 테스트 8건 — channel-post-card.tsx/channel-posts 목록/
  // useChannelPostCalendarData 전부 `formatScheduledAt`(절대포맷 전용, 실 코드 확認)만
  // 쓴다. 어떤 소비처도 scheduled_at을 실 now류와 비교하지 않는다(그룹핑도 날짜끼리
  // 대조지 wall-clock 비교가 아니다) — #4077 문서 §AC2 (c) 5 "절대포맷으로만 뜨고
  // 비교엔 안 쓰임" 부류와 동형.
  {
    file: 'app/(authenticated)/content/channel-posts/[draftId]/page.test.tsx', line: 2042, text: '2026-09-05T00:00:00Z',
    reason: '예약 발행 성공 안내 표시 여부만 단언(scheduled_at 값 자체는 무관, #4453류와 달리 비교 없음).',
  },
  {
    file: 'app/(authenticated)/content/channel-posts/[draftId]/page.test.tsx', line: 2076, text: '2026-09-05T00:00:00Z',
    reason: '예약 발행 성공 안내 표시 여부만 단언(scheduled_at 값 자체는 무관, #4453류와 달리 비교 없음).',
  },
  {
    file: 'app/(authenticated)/content/channel-posts/page.test.tsx', line: 396, text: '2026-09-15T09:00:00+00:00',
    reason: '목록 「나가는 시각」 칸 표시 — channel-post-card.tsx가 formatScheduledAt(절대포맷)만 쓴다.',
  },
  {
    file: 'components/content/channel-post-card.test.tsx', line: 57, text: '2026-09-05T12:00:00Z',
    reason: 'channel-post-card.tsx:65 formatScheduledAt(절대포맷 전용, 실 코드 확認) — 비교 없음.',
  },
  {
    file: 'components/content/use-channel-post-calendar-data.test.tsx', line: 82, text: '2026-09-05T21:00:00Z',
    reason: 'UTC 날짜 그룹핑 — scheduled_at끼리 대조(날짜 버킷)일 뿐 wall-clock 비교가 아니다.',
  },
  {
    file: 'components/content/use-channel-post-calendar-data.test.tsx', line: 83, text: '2026-09-05T09:00:00Z',
    reason: 'UTC 날짜 그룹핑 — scheduled_at끼리 대조(날짜 버킷)일 뿐 wall-clock 비교가 아니다.',
  },
  {
    file: 'components/content/use-channel-post-calendar-data.test.tsx', line: 84, text: '2026-09-10T00:00:00Z',
    reason: 'UTC 날짜 그룹핑 — scheduled_at끼리 대조(날짜 버킷)일 뿐 wall-clock 비교가 아니다.',
  },
  {
    file: 'components/content/use-channel-post-calendar-data.test.tsx', line: 193, text: '2026-09-05T21:00:00Z',
    reason: '재조회 실패 시 이전 데이터 유지 회귀가드 — scheduled_at 값 자체는 무관(존재 여부만 확認).',
  },
];

function isSentinelYear(year: number): boolean {
  return year <= SENTINEL_PAST_MAX_YEAR || year >= SENTINEL_FUTURE_MIN_YEAR;
}

function isAllowed(file: string, line: number, text: string): boolean {
  return ALLOWLIST.some((e) => e.file === file && e.line === line && e.text === text);
}

/** `new Date(2026, 8, 20, ...)` 생성자 스타일 — 첫 인자가 숫자 리터럴 연도일 때만. */
function dateCtorYear(node: ts.NewExpression): number | null {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'Date') return null;
  const args = node.arguments;
  if (!args || args.length === 0) return null;
  const first = args[0];
  if (!ts.isNumericLiteral(first)) return null;
  return Number(first.text);
}

/** 위험대(sentinel 밖) 리터럴 후보를 판정 — ISO 문자열이거나 `new Date(2026, ...)` 생성자. */
function dangerousLiteralYear(node: ts.Node): number | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const m = ISO_TIMESTAMP_YEAR_RE.exec(node.text);
    if (m) return Number(m[1]);
    return null;
  }
  if (ts.isNewExpression(node)) {
    const year = dateCtorYear(node);
    if (year !== null) return year;
  }
  return null;
}

function textOf(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.getText(sf);
}

/** 이 노드를 감싸는 가장 가까운 함수(콜백 포함) — describe/it/test/beforeEach 인자로
 * 넘긴 화살표함수·함수식이 자연스럽게 그 함수 자신이 된다(별도 describe 전용 판정 불요
 * — BE 자매 가드와 동일 "함수 단위" 사상). 못 찾으면 SourceFile(모듈 전체)로 넓힌다. */
function enclosingScope(node: ts.Node, sf: ts.SourceFile): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionExpression(cur) || ts.isArrowFunction(cur) || ts.isFunctionDeclaration(cur)) {
      return cur;
    }
    cur = cur.parent;
  }
  return sf;
}

/** 이 스코프 안 어딘가에 실 벽시계 호출(`Date.now()`·인자 없는 `new Date()`)이 있는지 —
 * BE `_has_live_now_call`과 동형 1차 게이트. */
function scopeHasLiveNowCall(scope: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Date'
      && node.expression.name.text === 'now'
    ) {
      found = true;
      return;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date' && (!node.arguments || node.arguments.length === 0)) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  }
  visit(scope);
  return found;
}

function isFreezeOrDiCall(node: ts.CallExpression): boolean {
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== 'vi') {
    return false;
  }
  if (expr.name.text === 'setSystemTime' || expr.name.text === 'useFakeTimers') return true;
  if (expr.name.text === 'spyOn') {
    const args = node.arguments;
    return args.length >= 2 && ts.isIdentifier(args[0]) && args[0].text === 'Date';
  }
  return false;
}

/** 이 스코프 안 freeze 호출(`vi.setSystemTime`/`vi.spyOn(Date,'now')`/`vi.useFakeTimers`)
 * 또는 DI 이름 관용구(변수/파라미터 선언 이름이 now/today/current/frozen/as_of/
 * fixed_now류) 존재 여부 — BE `_has_freeze_or_di_marker`와 동형. */
function scopeHasFreezeOrDiMarker(scope: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && isFreezeOrDiCall(node)) {
      found = true;
      return;
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node))
      && ts.isIdentifier(node.name)
      && DI_NAME_RE.test(node.name.text)
    ) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  }
  visit(scope);
  return found;
}

/** 리터럴 자신이 `const now = ...`/`const FIXED_NOW = ...`류 DI 이름 변수의 초기값이면
 * 스코프·live-now 게이트와 무관하게 자가면제(BE `_di_named_assignment_value_ids`와 동형). */
function isDiNamedAssignmentValue(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return DI_NAME_RE.test(parent.name.text);
  }
  return false;
}

/** 이 리터럴이 `scheduled_at: <literal>`류 시각-비교 민감 필드의 값인지 — #4453 원 사고
 * 모양(PropertyAssignment의 값, 객체 리터럴 프로퍼티). shorthand(`{ scheduled_at }`)는
 * 리터럴이 아니라 식별자라 애초에 대상 밖. */
function isTemporalFieldValue(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isPropertyAssignment(parent) || parent.initializer !== node) return false;
  const name = parent.name;
  const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
  return key !== null && TEMPORAL_FIELD_NAMES.has(key);
}

export function scanContent(content: string, file: string): Violation[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];
  const scopeMarkerCache = new Map<ts.Node, boolean>();
  const scopeLiveNowCache = new Map<ts.Node, boolean>();

  function walk(node: ts.Node): void {
    const year = dangerousLiteralYear(node);
    if (year !== null && !isSentinelYear(year) && !isDiNamedAssignmentValue(node)) {
      const scope = enclosingScope(node, sf);
      const bypassLiveNowGate = isTemporalFieldValue(node);
      // story #4079 실측 추가분(insights-board/page.test.tsx 실사례) — 감싸는 함수가
      // 없는 모듈 최상위 상수(예: `const ROW_A = {...}`, 여러 테스트가 공유하는 픽스처)는
      // scope가 SourceFile 전체로 넓어져 "이 3000줄 파일 어딘가에 Date.now()가 있다"는
      // 이유만으로 무관한 모듈 상수까지 쓸어 담는다(BE 자매 가드가 함수 단위로 좁힌 것과
      // 같은 이유의 재발). 모듈 최상위는 live-now 게이트를 아예 안 건다 — 실 비교는
      // 거의 항상 함수(테스트 콜백) 안에서 일어나므로, 필드명 우회만 여전히 유효하다.
      const isModuleTopLevel = scope === sf;
      let liveNow = isModuleTopLevel ? false : scopeLiveNowCache.get(scope);
      if (!isModuleTopLevel && liveNow === undefined) {
        liveNow = scopeHasLiveNowCall(scope);
        scopeLiveNowCache.set(scope, liveNow);
      }
      if (bypassLiveNowGate || liveNow) {
        let hasMarker = scopeMarkerCache.get(scope);
        if (hasMarker === undefined) {
          hasMarker = scopeHasFreezeOrDiMarker(scope);
          scopeMarkerCache.set(scope, hasMarker);
        }
        if (!hasMarker) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const text = textOf(node, sf);
          if (!isAllowed(file, line, text)) {
            violations.push({ file, line, text });
          }
        }
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return violations;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT_RE.test(entry)) {
      out.push(full);
    }
  }
}

function main(): number {
  const files: string[] = [];
  walk(SRC_ROOT, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(
      `스캔 대상 파일이 비정상적으로 적습니다(${files.length}건 < ${MIN_EXPECTED_FILES}) — ` +
        '경로가 잘못됐을 가능성(조용한 통과 대신 죽는다, story #3164/#3741류 관례).',
    );
  }

  const violations: Violation[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    violations.push(...scanContent(content, rel));
  }

  if (violations.length > 0) {
    console.log(`\n❌ apps/web/src 안 하드코드 절대 일시 리터럴 ${violations.length}건(story #4079 — #4453류 재발 클래스):`);
    for (const v of violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log(`  - ${v.file}:${v.line} ${JSON.stringify(v.text)}`);
    }
    console.log(
      '벽시계 고정 절대 타임스탬프는 시간이 지나면 조용히 썩는다 — vi.setSystemTime/FIXED_NOW류 고정 ' +
        '시각 픽스처로 바꾸거나, 정말 안전하면 이 스크립트의 ALLOWLIST에 file+line+text+reason으로 등재.',
    );
    return 1;
  }
  console.log(`OK: apps/web/src 안 하드코드 절대 일시 리터럴 0건(ALLOWLIST ${ALLOWLIST.length}건 제외)`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
