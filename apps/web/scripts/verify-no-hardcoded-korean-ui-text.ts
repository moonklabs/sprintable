/**
 * story #3741(유나 전수 2026-09-09 08:46Z, doc 08c58b24) — 영어 로케일 화면에 한글이 그대로
 * 서는 하드코딩 문자열의 «신규 증가»만 막는 baseline-freeze 회귀가드. 발견 계기는
 * `chats/page.tsx:19`의 `<EmptyState ... description="왼쪽에서 대화를 선택하세요" />` —
 * `t('title')`처럼 키를 쓰는 옆자리에 한글 문자열을 그대로 박아 둔 자리. 낱말이 틀린
 * 문제가 아니라 «영어 로케일 사용자가 한글을 그대로 본다» 문제다.
 *
 * `apps/web/scripts/verify-no-hardcoded-aria-label.ts`(story #3557)가 이미 있지만 그건
 * `aria-label={\`...\`}` 템플릿 리터럴 한 모양만 본다 — 보이는 본문(JSX 텍스트)·속성값을
 * 보는 가드는 이 스토리 前엔 0이었다.
 *
 * ## PO 판정 (a) — 축을 명단이 아니라 «한글 여부»로(2026-09-09 13:45Z, 유나 재실측)
 * 최초 판은 속성 축을 `placeholder`/`title`/`alt`/`aria-*` 4개로 못 박았다(그 밖은 후속
 * 확장 대상, ㉢ 각주). 유나가 레포 전체를 재실측하니 그 4축 밖에서 한글이 든 JSX 속성
 * 리터럴은 **3건/3파일**뿐(`description` 2 · `agentPlaceholder` 1)이었다 — "baseline
 * 재측정 비용이 커 별건"이라던 최초 판단의 전제(열 크기가 크다)가 실측과 어긋났다. 정정
 * — 지정 속성 명단을 아예 버리고, **문자열 리터럴 값을 가진 JSX 속성이면 이름 불문 전부**
 * 스캔한다(`isTargetAttrName`/`TARGET_ATTR_RE` 삭제) — "지정 경로만 막는 가드는 클래스를
 * 남긴다"는 지적을 반영, 새 속성 이름이 또 나와도 이 가드가 놓치지 않는다.
 *
 * ## 기전 — AST(verify-no-handrolled-card.ts와 동형, 새 기전 발명 금지)
 * 정규식 줄 스캔이 아니라 TypeScript AST를 walk한다 — 이유는 «주석은 절대 안 잡혀야
 * 한다»(이 저장소 주석은 한글 천지, 안 걸러지면 전부 오탐)인데, 주석은 AST 노드가
 * 아니라 trivia라 AST walk 자체가 자동으로 걸러준다(정규식처럼 별도로 주석을 벗겨낼
 * 필요가 없다 — 구조적으로 안전).
 *
 * ## story #3776(③, PO 判 2026-09-10 05:29Z) — «렌더 자리 화이트리스트»에서 «렌더 아닌
 * 자리 부정목록»으로 축 전체를 뒤집음(경위: 처음엔 «값으로 흘러가는 위치»만 화이트리스트로
 * 짚으려 했으나, 옵션 배열(`{ value:'a', label:'한글' }` → `.map()` 렌더)·라벨 맵·
 * `toast('한글')` 호출 인자처럼 «데이터 구조/함수 호출을 거쳐» 화면에 닿는 자리가
 * 끝없이 나와 화이트리스트가 못 따라갔다 — 유나 재실측으로 그 15건이 15/15 실제 렌더
 * 자리로 확認된 것이 이 반전의 근거). 「어디가 렌더 자리인가」는 열거가 안 끝나지만
 * 「어디가 렌더가 아닌가」는 유한하다(fail-closed 방향을 그쪽으로 둔다).
 *
 * 대상 노드 둘:
 *   ① `JsxText`(엘리먼트 사이 보이는 텍스트) — 한글 유니코드 포함 시 위반.
 *   ② `.tsx` 파일 안의 **모든** `StringLiteral`(속성 값·JSX 식 안 값·객체/배열 리터럴
 *      값·함수 호출 인자 전부 포함) — `isNonRenderStringLiteralPosition()`이 명시하는
 *      부정목록(비교 피연산자·switch case 값·객체/인터페이스 «키»·import/export 모듈
 *      경로·리터럴 타입 위치)에 걸리지 않으면 전부 위반. 이 통합 스캔이 구판의 ②
 *      (JsxAttribute 직접값)·③(JsxExpression 값-위치 화이트리스트) 둘 다를 포섭한다 —
 *      «식 안이냐 속성이냐»를 갈랐던 구분 자체가 사라졌다(같은 walk가 각 StringLiteral
 *      노드를 정확히 한 번만 방문 — 이중 계수 구조적으로 불가능).
 *
 * ## ③ .ts 파일은 「텍스트노드 모드」가 구조적으로 꺼진다
 * `.ts` 파일은 `ts.ScriptKind.TS`로 파싱한다(TSX 아님) — 그러면 `<`/`>`는 제네릭·비교
 * 연산자로만 해석되고 JSX로 절대 안 읽힌다. 유나 첫 판이 `.ts` 파일도 TSX로 파싱해
 * `Record<string, X>`류 제네릭의 `<…>`을 JSX로 오인해 오탐을 냈던 원인 — `.tsx`만
 * `ts.ScriptKind.TSX`로 파싱해 JsxText/JsxAttribute가 실제로 존재하는 파일에서만
 * 그 노드 종류가 나온다(별도 "모드 끄기" 플래그가 아니라 파서 자체가 자연히 그렇게
 * 된다 — 구조적 배제).
 *
 * ## 비목표
 * 기존 baseline(창건 시점 전수)을 전량 i18n 키로 옮기지 않는다 — 이 가드는 오직 «더
 * 늘지 않는다»만 보장한다. 전량 정리는 별건(스토리 明示).
 *
 * ⚠️이 가드가 «못 잡는»(또는 일부러 «안 잡는») 것:
 *   ㉠ 템플릿 리터럴 안의 한글(`` `${x} 왼쪽` ``류) — StringLiteral만 본다, 이유는
 *      템플릿 리터럴은 대개 동적 조합(순수 하드코딩이 아닌 경우가 섞여 오탐 위험이
 *      크다) — 필요해지면 별도 축.
 *   ㉡ 부정목록(`isNonRenderStringLiteralPosition`)에 든 자리 — 비교 피연산자·
 *      switch case·객체/인터페이스 «키»·import/export 경로·타입 위치·개발자 로그
 *      (`console.*`·`logger.*`)·문자열 검사 메서드(`includes`/`startsWith` 등) 인자.
 *      **정정(story #3776)** — `t('key', { x: '한글 기본값' })`처럼 함수 호출 인자
 *      안의 한글은 예전엔 축 밖이었으나, 이제 위 부정목록에 없는 호출 인자는 (옵션
 *      배열 값·`toast('한글')`류와 구분이 안 돼) **잡힌다** — next-intl 폴백 인자가
 *      실제로 이 축에 걸리면 baseline에 얹거나(사용자가 실제로 볼 수 있는 자리라면)
 *      호출부를 고친다(비교/로그처럼 명백히 렌더 아님이 확실해지면 부정목록에 추가).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// story #3741(스토리 明示 ④) — 내부 도그푸드·약관 화면은 허용목록(사유·카운트). 둘 다
// 일반 최종 사용자가 보는 제품 화면이 아니다: internal-dogfood는 무렌스 내부 전용
// 임시 경로(env flag로 통제)이고, terms/privacy/refund-policy는 법적 고지 문서라
// 한국어 원문이 그대로 서 있어도 되는 성격의 페이지(국문 법무 문서 번역은 별건 판단).
//
// story #3741(PO 明示, 2026-09-09 13:45Z) — 약관 셋(terms/privacy/refund-policy)의
// 만료 조건: 영어 약관 문서가 실제로 서면(en 로케일에 대응하는 법무 번역이 착지하면)
// 이 허용목록에서 걷는다 — 지금은 "국문 법무 문서라 정당한 예외"지만 미래엔 그 전제가
// 사라진다는 뜻. internal-dogfood는 무렌스 내부 전용이라 만료 조건이 다르다(별건).
// story #3776(1층A, PO 判 2026-09-10 05:41Z) — `verify-email/page.tsx`·`set-password/confirm/page.tsx`
// 둘 다 story #2484/#2485(유나 design 確認, 2026-08-06)로 **의도적으로 next-intl 미배선**
// 이었다(그 결정 당시 두 파일 자신의 머리 주석 — "#2484는 raw 서버 노출 제거만 스코프라
// 여기서 전면 i18n 전환은 안 함"). baseline 그랜드파더로 개별 텍스트만 얼리는 대신 파일째
// EXEMPT했던 이유 — 이 페이지들에 새로 추가되는 한국어 텍스트도(아직 존재하지 않는 것까지)
// 이 결정 아래 똑같이 유예 대상이라, 개별 baseline 항목으로는 "새 텍스트가 늘 때마다
// baseline을 또 늘려야" 하는데 그건 이 결정의 성격(파일 전체가 미배선)과 안 맞았다.
//
// story #3921(2026-09-15) — **만료 확認**. 그라운딩 中 "next-intl 미배선"이라는 전제
// 자체가 틀렸다는 게 드러났다 — `src/app/layout.tsx`가 `NextIntlClientProvider`를
// 전역(모든 페이지 공통) 제공 중이라 `useTranslations()`는 애초에 항상 됐다(login/
// register/page.tsx 등 형제 페이지가 실제로 그렇게 쓰고 있었다). #2484/#2485 당시의
// "미배선" 판단은 사실 오판이었던 것으로 보인다 — 이 스토리가 두 페이지를 실제로
// i18n 전환(verifyEmail.*·setPassword.* 네임스페이스, §⑤ 해요체)해 `computeDeadExemptFiles()`
// 자가검출이 정확히 예견한 대로 두 파일의 한글 히트가 0이 됐다 — 여기서 EXEMPT_FILES를
// 건는다(baseline이 그 20건만큼 늘어난 것으로 self-expire·grandfather로 복귀 0건, 새
// 코드는 전부 i18n 키라 baseline에 안 실린다).
// story #3930 PR③(2026-09-16, 페드루 확認·PO 승인) — 이 둘은 "UI 렌더 문구가 아니라
// 번역하면 오히려 깨지는 자리"라 baseline 그랜드파더가 아니라 파일째 EXEMPT한다.
//   `components/cage/gate-evidence.tsx`의 `_UNCONFIRMED = '미확認'` — BE(전역 sentinel
//   계약값, recipe_gate_hooks.py 등)가 실제로 보내는 값과 그대로 비교하는 상수. 번역하면
//   en 로케일에서 BE의 실 한글 sentinel과 매치가 깨진다(기능 회귀). ⚠️이 파일은 다른
//   자리에 정상 t() 소비처가 여러 곳 있다(cage ns) — 이 예외는 그 상수 하나 때문에 파일
//   전체 스캔을 끈다는 뜻이라, 새 하드코딩 한국어가 이 파일에 더 생겨도 이 가드가 못
//   잡는다(범위 자각, 필요해지면 라인 단위 예외로 좁히는 후속 별건).
//   `components/locale-switcher.tsx`의 `한국어로 변경` — 로케일 스위처 자체가 "지금
//   아닌 언어로 전환" 툴팁이라 항상 그 언어 자체의 문자로 서야 한다(en일 때 「한국어」로
//   보여야 사용자가 알아봄, 대칭축 반대편 en 문구 "Switch to English"도 코드에 이미
//   하드코딩 — 둘 다 로케일 자체를 가리키는 라벨이라 번역 대상이 아님). 이 파일은
//   전체가 이 라벨 하나뿐이라 위 gate-evidence와 달리 범위 자각 리스크가 낮다.
export const EXEMPT_FILES = new Set<string>([
  'app/internal-dogfood/page.tsx',
  'app/terms/page.tsx',
  'app/privacy/page.tsx',
  'app/refund-policy/page.tsx',
  'components/cage/gate-evidence.tsx',
  'components/locale-switcher.tsx',
]);

const HANGUL_RE = /[가-힣]/;

export interface Violation {
  file: string;
  line: number;
  text: string;
}

export function scanContent(content: string, file: string): Violation[] {
  const isTsx = file.endsWith('.tsx');
  const sf = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const violations: Violation[] = [];
  function addIfHangul(node: ts.Node, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length > 0 && HANGUL_RE.test(trimmed)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      violations.push({ file, line, text: trimmed });
    }
  }

  function walk(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      addIfHangul(node, node.getText(sf));
    } else if (isTsx && ts.isStringLiteral(node) && !isNonRenderStringLiteralPosition(node)) {
      // story #3776(③, PO 判 2026-09-10 05:29Z — 「어디가 렌더 자리인가」는 열거가 안
      // 끝난다(옵션 배열·라벨 맵·toast 인자·속성 식…) 「어디가 렌더가 아닌가」는 손가락
      // 으로 센다 — fail-closed 방향을 뒤집는다). 최초 판(①JsxText+②JsxAttribute
      // 직접값+③JsxExpression 값-위치 화이트리스트, 3단 분리)은 데이터 구조를 거쳐
      // 화면에 닿는 자리(`{ value:'a', label:'한글' }` 옵션 배열 → `.map()` 렌더,
      // `toast('한글')` 호출 인자)를 못 봤다(유나 실측 15/15가 실은 화면에 서는 글자 —
      // PO가 축을 뒤집은 근거). .tsx 파일의 문자열 리터럴은 이제 기본이 «잡힌다»고
      // 보고, 아래 `isNonRenderStringLiteralPosition`의 명시적 부정목록(비교 피연산자·
      // switch case·객체/인터페이스 «키»·import/export 경로·타입 위치)만 뺀다. 이
      // 통합 스캔이 ②(JsxAttribute 직접값)를 포섭한다(속성 리터럴도 그냥 StringLiteral
      // 노드라 같은 walk 한 번에 걸린다 — «식 안 문자열»·«속성 값»을 갈랐던 옛 구분 자체가
      // 사라진다) — 이중 계수 0(각 StringLiteral 노드는 정확히 한 번만 방문된다).
      addIfHangul(node, node.text);
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return violations;
}

// story #3776(③, PO 判 2026-09-10 05:29Z) — «렌더 아닌 자리»만 명시적으로 뺀다. 이
// 목록에 없는 자리는 전부 포함(fail-closed — 새 반례가 나오면 실측으로 추가, 임의
// 선제 확장 금지). picture: `x === '한글'`(비교)·`case '한글':`(스위치)·
// `{ '한글': 1 }`의 키 위치(값 위치는 포함)·import/export 모듈 경로·리터럴 타입
// 위치(`type X = '한글'`)만 빠진다.
const COMPARISON_OPERATOR_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);
const LOG_METHOD_NAMES = new Set(['log', 'error', 'warn', 'info', 'debug', 'trace']);
const STRING_CHECK_METHOD_NAMES = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'match', 'search']);

function isNonRenderStringLiteralPosition(lit: ts.StringLiteral): boolean {
  const parent = lit.parent;
  if (!parent) return false;

  // 비교 피연산자 — 불린만 만들 뿐 화면에 그려지지 않는다.
  if (
    ts.isBinaryExpression(parent) && (parent.left === lit || parent.right === lit) &&
    COMPARISON_OPERATOR_KINDS.has(parent.operatorToken.kind)
  ) {
    return true;
  }

  // switch case 값 — 매칭용, 렌더 아님.
  if (ts.isCaseClause(parent) && parent.expression === lit) return true;

  // story #3776(유나 확認 05:41Z) — 경계 한 줄: 호출 인자는 받는 쪽이 사람인가 개발자인가로
  // 가른다(console/logger는 밖, toast/alert/confirm은 안 — toast('한글')는 PropertyAssignment
  // 값이 아니라 이 규칙 자체를 안 건드려도 이미 축 안이다, 아래 실측). 객체 리터럴은 키는
  // 밖·값은 안(옵션 배열 label처럼 값이 데이터 구조를 거쳐 화면에 닿는 자리가 실재하므로).
  // 객체 리터럴/인터페이스/클래스의 «키»(값 아님) — 계산된 프로퍼티 값은 여기 안 걸린다.
  if (ts.isPropertyAssignment(parent) && parent.name === lit) return true;
  if (ts.isPropertySignature(parent) && parent.name === lit) return true;
  if (ts.isMethodSignature(parent) && parent.name === lit) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === lit) return true;

  // `obj['한글']` 인덱스 접근 — 조회 키다(값을 꺼낼 뿐 그 키 문자열 자체는 안 그려진다).
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === lit) return true;

  // import/export 모듈 경로.
  if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === lit) return true;
  if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === lit) return true;

  // 타입 위치(리터럴 타입, 예: `type X = '한글'`).
  if (ts.isLiteralTypeNode(parent)) return true;

  // story #3776(유나 실측 05:31Z 추가) — 개발자 로그(console.*·`logger.*`/`this.logger.*`)
  // 인자·문자열 검사 메서드(includes/startsWith/endsWith/indexOf/match/search) 인자는
  // 사용자 화면이 아니라 개발자 콘솔·내부 판정 로직으로 흐른다 — 사용자 화면과 개발자
  // 로그를 안 섞는다(별 축).
  if (ts.isCallExpression(parent) && parent.arguments.includes(lit)) {
    const callee = parent.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const objectText = callee.expression.getText();
      const methodName = callee.name.text;
      if (objectText === 'console') return true;
      if (/\blogger$/.test(objectText) && LOG_METHOD_NAMES.has(methodName)) return true;
      if (STRING_CHECK_METHOD_NAMES.has(methodName)) return true;
    }
  }

  return false;
}

const EXT_RE = /\.tsx?$/;
const TEST_RE = /\.test\.tsx?$/;
// self-assert — 재료가 비정상적으로 적으면(가드가 헛돌고 있으면) 조용한 통과 대신 죽는다.
const MIN_EXPECTED_FILES = 400;

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
    if (EXEMPT_FILES.has(rel)) continue;
    const content = readFileSync(abs, 'utf8');
    violations.push(...scanContent(content, rel));
  }
  return violations;
}

/** violation의 안정 키 — 파일+텍스트(줄 번호 제외, 인접 편집에 안 흔들리게 —
 * verify-no-handrolled-card.ts violationKey와 동일 계약). */
export function violationKey(v: Pick<Violation, 'file' | 'text'>): string {
  return `${v.file}::${v.text}`;
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'hardcoded-korean-ui-text-baseline.json');

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

// story #3164 PR#3580 관례 — main()과 .test.ts가 같은 판정 심볼을 부르게 export(드리프트
// 방지).
export function computeNewViolations(violations: Violation[], baseline: Set<string>): Violation[] {
  return violations.filter((v) => !baseline.has(violationKey(v)));
}

// story #3776(③-b) — baseline에 등재됐으나 이번 스캔에서 안 걸린(고쳐졌거나 삭제된) 항목.
// main()과 같은 심볼을 써서 드리프트를 막는다(computeNewViolations와 동형 관례).
export function computeStaleBaseline(violations: Violation[], baseline: Set<string>): string[] {
  const foundKeys = new Set(violations.map(violationKey));
  return [...baseline].filter((k) => !foundKeys.has(k));
}

// story #3776(유나 지적 06:09Z) — baseline은 stale(고쳐졌는데 안 지운 항목)을 자가검출하지만
// EXEMPT_FILES는 `scanRepo()`가 그냥 `continue`로 건너뛰어 죽은 예외를 아무도 안 알려준다
// (#2485가 착지해 verify-email/set-password 두 파일이 i18n 배선돼도 EXEMPT_FILES에 그대로
// 남아 20건이 영영 안 세어질 위험). baseline의 stale 검사와 같은 모양으로: EXEMPT 파일을
// «건너뛰지 않고 따로» 스캔해, 이번 스캔에서 한글 0건인 파일(=이미 고쳐진 파일)을 낸다.
export function computeDeadExemptFiles(srcRoot: string): string[] {
  const dead: string[] = [];
  for (const rel of EXEMPT_FILES) {
    const abs = path.join(srcRoot, ...rel.split('/'));
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      // 파일 자체가 없어졌다(경로 오타·이동) — 이 검사의 책임 밖(별도 실패 모드로 드러남).
      continue;
    }
    if (scanContent(content, rel).length === 0) dead.push(rel);
  }
  return dead;
}

function main(): number {
  let violations: Violation[];
  try {
    violations = scanRepo(SRC_ROOT);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const baseline = loadBaseline(BASELINE_PATH);

  const newViolations = computeNewViolations(violations, baseline);
  const staleBaseline = computeStaleBaseline(violations, baseline);

  const fileCount = new Set(violations.map((v) => v.file)).size;
  console.log(
    `[story #3741] 한글 하드코딩 UI 텍스트 스캔 — 검출 ${violations.length}건/${fileCount}파일 · ` +
      `baseline(grandfather) ${baseline.size}건 · 신규 ${newViolations.length}건 · stale ${staleBaseline.length}건`,
  );

  let failed = false;

  if (newViolations.length > 0) {
    failed = true;
    console.error('\nFAIL: baseline에 없는 한글 하드코딩 UI 텍스트 발견(story #3741 회귀):');
    for (const v of newViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(`  - ${v.file}:${v.line} "${v.text}"`);
    }
    console.error(
      '\n→ 영어 로케일 사용자가 이 한글을 그대로 본다. next-intl i18n 키(messages/ko.json·en.json)로 옮길 것 — ' +
        '내부 도그푸드·약관처럼 정말 정당한 예외라면 EXEMPT_FILES에 사유와 함께 등재(PO 승인).',
    );
  }

  // story #3776(③-b, PO 判) — 예전엔 ⚠️ 경고만 찍고 exit 0이었다(죽은 baseline 항목이
  // 영영 안 걸림). 고쳐진 자리를 지우는 걸 깜빡하면 이 가드가 스스로 RED로 잡는다(유나가
  // 원한 「죽은 항목 자가검출」 성질) — baseline은 «지금도 실재하는» 위반의 목록이어야
  // 한다는 계약이므로, 실재하지 않는 항목이 남아 있는 것 자체가 계약 위반이다.
  if (staleBaseline.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: baseline에 ${staleBaseline.length}건이 등재됐으나 이번 스캔에서 안 걸렸다(story #3776 ③-b 회귀):`,
    );
    for (const k of staleBaseline.sort()) {
      console.error(`  - ${k}`);
    }
    console.error('\n→ 고쳐졌다면(i18n 키로 옮겼거나 삭제했다면) baseline에서 그 항목을 지울 것.');
  }

  // story #3776(유나 지적 06:09Z) — EXEMPT_FILES는 baseline과 달리 자가만료가 없었다
  // (scanRepo가 그냥 건너뛸 뿐, 배선이 끝난 뒤에도 아무도 안 알려준다). 파일 전체가
  // «이번 스캔에서 한글 0건»이면 고쳐진 것 — EXEMPT에서 걷을 것.
  const deadExempt = computeDeadExemptFiles(SRC_ROOT);
  if (deadExempt.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: EXEMPT_FILES 중 ${deadExempt.length}개가 이번 스캔에서 한글 0건이다(story #3776 EXEMPT 자가만료 회귀):`,
    );
    for (const f of deadExempt.sort()) {
      console.error(`  - ${f}`);
    }
    console.error('\n→ 배선이 끝났다면(next-intl i18n 전환 완료) EXEMPT_FILES에서 그 파일을 뺄 것.');
  }

  if (failed) return 1;

  console.log('\nOK: baseline 초과 없음(0건 증가) · stale 0건(0건 감소 없이 죽은 항목 없음).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const violations = scanRepo(SRC_ROOT);
    const keys = [...new Set(violations.map(violationKey))].sort();
    const out: BaselineFile = {
      _comment: [
        'story #3741(유나 전수 2026-09-09) grandfather baseline — 이 가드 첫 도입 시점 develop의 ' +
          '기존 한글 하드코딩 UI 텍스트(JsxText·JSX 문자열 속성값 전체).',
        '마이그레이션 대상 아님 — 이 게이트는 "더 늘지 않는다"만 보장한다(freeze, 전량 i18n 키화는 후속 별건).',
        'story #3741(PO 判 (a), 2026-09-09 13:45Z 재실측) — 최초 판은 속성 축을 placeholder/' +
          'title/alt/aria-* 4개로 제한했으나, 유나 재실측(4축 밖 한글 속성 3건/3파일 — ' +
          'description 2·agentPlaceholder 1)에 따라 속성 이름 명단을 버리고 문자열 리터럴 ' +
          '값을 가진 JSX 속성 전부로 넓혔다(+3건). chats/page.tsx의 description="왼쪽에서 ' +
          '대화를 선택하세요"(이 스토리의 창건 사례)가 이 재측정으로 baseline에 정식 편입됐다.',
      ],
      keys,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
