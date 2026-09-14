/**
 * story #3839(critical·2pt, 카디르 QA 2026-09-14 01:18Z) AC2 — tint 배경(destructive/
 * info/success/warning의 `-tint`/`-bg` 옅은 채움) 서브트리 안 `text-muted-foreground`
 * 정적 재발 방지 가드.
 *
 * 왜 muted가 특별 취급인지: `--muted-foreground`(ink-3, #6E6C67)는 그 짝인 `--muted`
 * (sunk, #F1EFEA) 배경 기준으로 AA 맞춰 조정된 값이다(4.56:1, globals.css §ink-3 주석
 * 근거) — 그러나 family tint(예: info-tint #E7EDF7)는 sunk보다 훨씬 옅어 그 위에선
 * 4.5 밑으로 떨어진다(실측 ≈4.3:1). #4255(알파 합성→solid muted)+#4254(ink-3 v3 값
 * 상향) 조합이 이 구멍을 열었다 — activation-checklist-banner.tsx 3곳이 실사고(PR
 * #4259에 동봉 수정, 이 가드 착지 전에 이미 반영됨).
 *
 * bg-muted 자체는 대상 밖이다(그건 이미 calibrated된 원래 짝 — 위 근거).
 *
 * ⚠️카디르 QA 지적(2026-09-14 05:30Z, PO 재검) — 최초판은 「같은 요소·JSX 리터럴
 * className」만 봐서, activation-checklist-banner.tsx의 실제 조상(`<Alert variant=
 * "info">`)처럼 tint 배경이 **cva variant 정의 안**(alert.tsx의 `alertVariants`)에서
 * 나오는 컴포넌트 경계를 못 넘었다 — 실 파일에서 고친 3곳 중 1곳을 되돌려도(met ?
 * text-foreground : text-muted-foreground) 「신규 위반 0」으로 통과하는 거짓 OK가
 * 재현됐다. AC2가 막으려던 바로 그 패턴이라 한계 수용이 아니라 보강이 맞다.
 *
 * 처방: `buildComponentTintMap()`이 스캔 시점에 `src/components/ui/*.tsx`의 cva()
 * 정의를 AST로 읽어 «컴포넌트·variant축·값 → tint 계열» 지도를 만든다(하드코딩 0 —
 * 컴포넌트 이름·계열 어느 것도 손으로 나열하지 않는다). JSX 워커는 `<Alert
 * variant="info">`처럼 그 지도에 있는 조합을 리터럴 `bg-info-tint` 조상과 동일하게
 * 취급한다. **완전성 fail-closed**: 그 파일들의 원시 정규식 매치 수(주석 제외)가
 * 구조화 추출이 처리한(entries+incomplete) 수보다 많으면(추출이 못 옮긴 tint 자리가
 * 있다는 뜻) 또는 어떤 tint 변형이 컴포넌트 이름을 0개/2개+로 모호하게 찾으면 가드
 * 자체가 즉시 FAIL한다(조용히 건너뛰지 않는다).
 *
 * 자매 가드 verify-cross-element-tint-text.ts(story #2590 A)와 같은 원리(JSX 트리
 * 파싱 + 조상 pale-bg 추적)를 쓰되 대상 클래스가 다르다(계열색 아닌 muted-foreground
 * 정확매치라 size/icon 예외가 불요) — 그 파일은 그대로 두고 별도 스크립트로 낸다
 * (회귀 위험 0, 두 가드 독립 유지).
 *
 * baseline은 verify-no-new-alpha-text-foreground.ts와 동형 관례(카디르 QA 지적,
 * PR#4255 후속) — Set 존재여부가 아니라 `file::muted-on-{family}-tint` → 그 조합의
 * 정확한 발생 개수(Map). 실측이 baseline보다 많으면(신규/증가) FAIL, 적으면(stale,
 * 고쳤는데 목록을 안 뺌) 이것도 FAIL — 정확히 일치해야 GREEN.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const UI_DIR = path.join(SRC_ROOT, 'components/ui');
const EXT_RE = /\.tsx$/;
const TEST_RE = /\.test\.tsx$/;
const MIN_EXPECTED_FILES = 300;

const TINT_FAMILIES = ['destructive', 'info', 'success', 'warning'] as const;
export type TintFamily = (typeof TINT_FAMILIES)[number];

// (?<![\w:-]) — 앞이 글자/숫자/-/: 가 아니어야 매치(카디르 지적 반영: `hover:`·`data-[...]:focus:`
// 같은 상태 한정자 뒤에 붙은 tint는 "항상 적용"이 아니라 정적 가드 밖 — dropdown-menu.tsx의
// `data-[variant=destructive]:focus:bg-destructive-tint`가 실 반례).
const TINT_FAMILY_BG_RE = new RegExp(
  `(?<![\\w:-])bg-(${TINT_FAMILIES.join('|')})-(?:tint|bg)(?:/\\d+)?(?![\\w-])`,
);
const TINT_FAMILY_BG_RE_G = new RegExp(TINT_FAMILY_BG_RE.source, 'g');
const MUTED_TEXT_RE = /(?<![\w-])text-muted-foreground(?![\w-])/;

/** varName → 그 변수가 가질 수 있는 class 후보 문자열 목록(story #3850 — 객체 맵/삼항/
 * 템플릿 리터럴을 거쳐 JSX에 닿는 tint를 추적하기 위한 이름 해석 표). 빈 표가 기본값 —
 * 기존 호출부(바인딩 모르는 자리)는 동작 무변. */
type ClassBindings = ReadonlyMap<string, readonly string[]>;
const NO_BINDINGS: ClassBindings = new Map();

function classStringsFromExpr(e: ts.Expression, bindings: ClassBindings = NO_BINDINGS): string[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) {
    // story #3850 — 정적 부분만 보고 `${...}` 치환식 안(삼항·바인딩 참조 등)은 통째로
    // 무시하던 것을 고친다(invite-accept-client.tsx류 — 삼항이 템플릿 치환 «안»에 있어
    // 이전엔 조상 추적·완전성 대조 둘 다 못 봤다). 치환식도 재귀 추출해 합친다.
    const staticJoin = [e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)].join(' ');
    const dynamic = e.templateSpans.flatMap((sp) => classStringsFromExpr(sp.expression, bindings));
    return [staticJoin, ...dynamic];
  }
  if (ts.isParenthesizedExpression(e)) return classStringsFromExpr(e.expression, bindings);
  if (ts.isCallExpression(e) && /(?:^|\.)cn$/.test(e.expression.getText())) {
    // #2590 A(verify-cross-element-tint-text.ts)와 달리 재귀 처리한다 — 실사고
    // (activation-checklist-banner.tsx)가 정확히 `cn('...', met ? 'a' : 'b')` 형태라,
    // cn() 인자가 문자열 리터럴일 때만 보면 그 삼항이 통째로 빠져 정작 막으려던 자리를
    // 못 잡는다(뮤테이션 테스트가 이 구멍을 실측으로 잡아냈다). 인자별로 재귀해 삼항의
    // 두 branch 모두 수집 — && 등 그 외 조건부는 classStringsFromExpr가 여전히 []로 제외.
    return e.arguments.flatMap((a) => classStringsFromExpr(a, bindings));
  }
  if (ts.isConditionalExpression(e)) {
    return [...classStringsFromExpr(e.whenTrue, bindings), ...classStringsFromExpr(e.whenFalse, bindings)];
  }
  // story #3850(AC1 축 b, 국소) — `X ?? Y`/`X || Y`는 &&와 달리 「둘 중 하나가 항상
  // 결과가 된다」는 보장이 있는 폴백 관용구(예: `STATUS_COLOR[id] ?? STATUS_COLOR['backlog']`)
  // — 두 피연산자를 조상 후보로 함께 수집한다(#2590 A의 && 배제 정밀성은 그대로 유지 —
  // &&는 "적용 안 됨"이 결과일 수 있어 이 식과 성격이 다르다).
  if (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...classStringsFromExpr(e.left, bindings), ...classStringsFromExpr(e.right, bindings)];
  }
  if (ts.isIdentifier(e)) return [...(bindings.get(e.text) ?? [])];
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    // story #3850(AC1 축 a) — `STATUS_COLOR[id].tint`·`statusColor.dot`처럼 객체 맵을
    // 프로퍼티/첨자로 조회하는 자리. 어느 키가 실제로 오는지는 정적으로 모르므로(변수
    // 조회) 보수적으로 그 루트가 가진 후보 문자열 전부를 반환한다(어느 프로퍼티가 오든
    // — .dot이든 .tint든 — 그 객체 전체에서 나온 tint를 조상 후보로 취급). 루트가
    // 이름 있는 식별자가 아니라 `{ idle: {...}, ... }[fallback]`처럼 인라인 객체
    // 리터럴 자체일 수도 있다(stuck-handoff-section.tsx류) — 그 경우 즉석에서 값을 뽑는다.
    let root: ts.Expression = e;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
    if (ts.isObjectLiteralExpression(root)) return collectObjectLiteralClassStrings(root, bindings);
    return ts.isIdentifier(root) ? [...(bindings.get(root.text) ?? [])] : [];
  }
  return []; // BinaryExpression(x && 'y') 등 조건부 = 항상적용 보장 안 됨 → 제외(정밀, #2590 A 관례 그대로).
}

function classNameStringsOf(opening: ts.JsxOpeningLikeElement, bindings: ClassBindings = NO_BINDINGS): string[] {
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === 'className' && a.initializer) {
      if (ts.isStringLiteral(a.initializer)) return [a.initializer.text];
      if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
        return classStringsFromExpr(a.initializer.expression, bindings);
      }
    }
  }
  return [];
}

/** 한 JSX 요소의 (props 이름 → 리터럴 문자열 값) — variant="info" 같은 것만(동적 값은
 * "항상 적용 보장 안 됨"이라 #2590 A와 같은 정밀성으로 제외). */
function literalPropsOf(opening: ts.JsxOpeningLikeElement): Map<string, string> {
  const props = new Map<string, string>();
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.initializer) {
      const name = a.name.getText();
      if (ts.isStringLiteral(a.initializer)) {
        props.set(name, a.initializer.text);
      } else if (
        ts.isJsxExpression(a.initializer) &&
        a.initializer.expression &&
        ts.isStringLiteral(a.initializer.expression)
      ) {
        props.set(name, a.initializer.expression.text);
      }
    }
  }
  return props;
}

// ── cva variant → tint 계열 지도 추출(카디르 QA 보강, 2026-09-14) ──────────────────

/** componentTag → axisPropName → axisValue → family */
export type ComponentTintMap = Map<string, Map<string, Map<string, TintFamily>>>;

export interface CvaExtractionResult {
  map: ComponentTintMap;
  /** 완전성 fail-closed 사유 — 비어있지 않으면 main()이 FAIL해야 한다. */
  incompleteReasons: string[];
  /** 이 파일의 cva variants 안에서 tint로 인식된 매치 총수(map에 실렸든 incomplete로
   * 신고됐든 전부 포함) — 전 트리 완전성 대조(analyzeTreeForTintCompleteness)가 쓴다. */
  accountedMatches: number;
}

/** 한 ui 컴포넌트 파일에서 cva() 정의를 읽어 {cva 변수명 → axis → value → class문자열}을
 * 뽑고, 그 cva 변수를 호출하는 대문자 시작 컴포넌트 이름을 찾아 지도를 만든다. 컴포넌트를
 * 못 찾거나(0개) 여러 개로 모호하면(2개+) 그 축·값은 incompleteReasons에 실린다(하드코딩
 * 없이 "손 못 댄 자리"를 스스로 신고 — 조용히 건너뛰지 않는다). */
export function extractCvaTintVariants(content: string, file: string): CvaExtractionResult {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  interface CvaDef { varName: string; axisValues: Map<string, Map<string, string>>; }
  const cvaDefs: CvaDef[] = [];

  function stringFromExpr(e: ts.Expression): string | null {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) return [e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)].join(' ');
    return null;
  }

  function propKeyName(name: ts.PropertyName): string {
    const text = name.getText();
    return text.replace(/^['"]|['"]$/g, '');
  }

  function collectCvaDefs(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'cva' &&
      ts.isIdentifier(node.name)
    ) {
      const varName = node.name.text;
      const optsArg = node.initializer.arguments[1];
      const axisValues = new Map<string, Map<string, string>>();
      if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
        for (const prop of optsArg.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            propKeyName(prop.name) === 'variants' &&
            ts.isObjectLiteralExpression(prop.initializer)
          ) {
            for (const axisProp of prop.initializer.properties) {
              if (ts.isPropertyAssignment(axisProp) && ts.isObjectLiteralExpression(axisProp.initializer)) {
                const axisName = propKeyName(axisProp.name);
                const valueMap = new Map<string, string>();
                for (const valProp of axisProp.initializer.properties) {
                  if (ts.isPropertyAssignment(valProp)) {
                    const cls = stringFromExpr(valProp.initializer);
                    if (cls !== null) valueMap.set(propKeyName(valProp.name), cls);
                  }
                }
                axisValues.set(axisName, valueMap);
              }
            }
          }
        }
      }
      cvaDefs.push({ varName, axisValues });
    }
    node.forEachChild(collectCvaDefs);
  }
  collectCvaDefs(sf);

  // cva 변수를 호출하는(예: alertVariants({ variant })) 가장 가까운 대문자 컴포넌트를 찾는다
  // — forwardRef((...) => ...)에 할당된 const나 function 선언, 둘 다 커버.
  function findEnclosingComponentName(node: ts.Node): string | null {
    let cur: ts.Node | undefined = node;
    while (cur) {
      if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && /^[A-Z]/.test(cur.name.text)) {
        return cur.name.text;
      }
      if (ts.isFunctionDeclaration(cur) && cur.name && /^[A-Z]/.test(cur.name.text)) {
        return cur.name.text;
      }
      cur = cur.parent;
    }
    return null;
  }

  const cvaVarNames = new Set(cvaDefs.map((d) => d.varName));
  const cvaVarToComponents = new Map<string, Set<string>>();
  function collectUsages(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && cvaVarNames.has(node.expression.text)) {
      const varName = node.expression.text;
      const comp = findEnclosingComponentName(node);
      if (comp) {
        if (!cvaVarToComponents.has(varName)) cvaVarToComponents.set(varName, new Set());
        cvaVarToComponents.get(varName)!.add(comp);
      }
    }
    node.forEachChild(collectUsages);
  }
  collectUsages(sf);

  const map: ComponentTintMap = new Map();
  const incompleteReasons: string[] = [];
  let accountedMatches = 0;

  for (const def of cvaDefs) {
    const comps = cvaVarToComponents.get(def.varName);
    for (const [axis, valueMap] of def.axisValues) {
      for (const [value, cls] of valueMap) {
        const matches = cls.match(TINT_FAMILY_BG_RE_G);
        if (!matches || matches.length === 0) continue;
        accountedMatches += matches.length;
        const family = matches[0]!.match(TINT_FAMILY_BG_RE)![1] as TintFamily;
        if (!comps || comps.size === 0) {
          incompleteReasons.push(
            `${file}::${def.varName}.${axis}.${value} — tint(${family}) 클래스가 있지만 이 cva를 쓰는 컴포넌트를 못 찾음`,
          );
          continue;
        }
        if (comps.size > 1) {
          incompleteReasons.push(
            `${file}::${def.varName}.${axis}.${value} — tint(${family}) 클래스인데 이 cva를 쓰는 컴포넌트가 ${comps.size}개로 모호함(${[...comps].join(', ')})`,
          );
          continue;
        }
        const comp = [...comps][0]!;
        if (!map.has(comp)) map.set(comp, new Map());
        if (!map.get(comp)!.has(axis)) map.get(comp)!.set(axis, new Map());
        map.get(comp)!.get(axis)!.set(value, family);
      }
    }
  }

  // 완전성 크로스체크 — 이 파일 전체(주석 제외)의 원시 tint 매치 수가 cva 구조화 추출이
  // 처리한(=map에 실렸거나 incomplete로 신고한) 수보다 많으면, cva variants 밖(또는 내가
  // 못 파싱한 형태) 어딘가에 tint 클래스가 있다는 뜻 — 조용히 건너뛰지 않고 FAIL한다.
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const rawMatches = stripped.match(TINT_FAMILY_BG_RE_G) ?? [];
  if (rawMatches.length > accountedMatches) {
    incompleteReasons.push(
      `${file} — 파일 전체 tint 클래스 원시 매치 ${rawMatches.length}건 > cva 구조화 추출이 처리한 ${accountedMatches}건(추출 완전성 fail-closed)`,
    );
  }

  return { map, incompleteReasons, accountedMatches };
}

function mergeComponentTintMaps(a: ComponentTintMap, b: ComponentTintMap): void {
  for (const [comp, axisMap] of b) {
    if (!a.has(comp)) a.set(comp, new Map());
    for (const [axis, valueMap] of axisMap) {
      if (!a.get(comp)!.has(axis)) a.get(comp)!.set(axis, new Map());
      for (const [value, family] of valueMap) {
        a.get(comp)!.get(axis)!.set(value, family);
      }
    }
  }
}

/** `src/components/ui/*.tsx`(비재귀 — 카디르 지시 그대로)를 스캔해 컴포넌트 지도를 만든다.
 * 하드코딩 0 — 컴포넌트 이름·계열 어느 것도 이 함수 밖에 나열하지 않는다. */
export function buildComponentTintMap(uiDir: string): CvaExtractionResult {
  const map: ComponentTintMap = new Map();
  const incompleteReasons: string[] = [];
  let accountedMatches = 0;
  let entries: string[];
  try {
    entries = readdirSync(uiDir).filter((e) => EXT_RE.test(e) && !TEST_RE.test(e));
  } catch {
    incompleteReasons.push(`${uiDir} — 디렉터리를 못 읽음(가드가 헛돈다)`);
    return { map, incompleteReasons, accountedMatches };
  }
  for (const entry of entries) {
    const abs = path.join(uiDir, entry);
    if (statSync(abs).isDirectory()) continue;
    const content = readFileSync(abs, 'utf8');
    const rel = `components/ui/${entry}`;
    const result = extractCvaTintVariants(content, rel);
    mergeComponentTintMaps(map, result.map);
    incompleteReasons.push(...result.incompleteReasons);
    accountedMatches += result.accountedMatches;
  }
  return { map, incompleteReasons, accountedMatches };
}

/** 리터럴 JSX className 안 tint 매치 총수(조상 추적 없이 존재만 센다) — 전 트리 완전성
 * 대조(analyzeTreeForTintCompleteness)가 "리터럴 className으로 처리된 것"을 세는 축. */
function countLiteralClassNameTintMatches(content: string, file: string): number {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  function walk(node: ts.Node): void {
    let opening: ts.JsxOpeningLikeElement | null = null;
    if (ts.isJsxElement(node)) opening = node.openingElement;
    else if (ts.isJsxSelfClosingElement(node)) opening = node;
    if (opening) {
      const cls = classNameStringsOf(opening).join(' ');
      const matches = cls.match(TINT_FAMILY_BG_RE_G);
      if (matches) count += matches.length;
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return count;
}

function collectObjectLiteralClassStrings(obj: ts.ObjectLiteralExpression, bindings: ClassBindings): string[] {
  const out: string[] = [];
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue; // shorthand/spread/계산된 키는 미지원 — 아래 완전성 fail-closed가 raw>explained로 대신 잡는다.
    if (ts.isObjectLiteralExpression(prop.initializer)) {
      out.push(...collectObjectLiteralClassStrings(prop.initializer, bindings)); // 중첩 객체(예: STATUS_COLOR 값이 {dot,tint})
    } else {
      out.push(...classStringsFromExpr(prop.initializer as ts.Expression, bindings));
    }
  }
  return out;
}

export interface LocalTintBindingsResult {
  /** varName → 그 변수의 초기값에서 뽑아낸 class 후보 문자열 전부(어느 키/분기가 실제로
   * 선택되는지는 정적으로 모르므로 전부 보수적으로 보관 — scanContent가 JSX 소비 지점에서
   * 조상 후보로 재사용한다). */
  bindings: Map<string, string[]>;
  /** bindings에 실린 문자열들 안에서 찾은 tint 매치 총수 — 이 값들의 원문 텍스트가 바로
   * "raw" 정규식이 이미 그 자리(변수 선언문 자체)에서 센 것과 같은 자리이므로, 완전성
   * 대조의 explained 항에 더하면 그 선언 자리의 raw를 정확히 상쇄한다(중복 계산 없음 —
   * JSX 소비 지점은 그 텍스트를 다시 갖고 있지 않다, identifier/property-access일 뿐). */
  accountedMatches: number;
}

/** story #3850(AC1) — 객체 맵(`const STATUS_COLOR = { key: { tint: 'bg-...-tint' } }`류)과
 * 로컬 삼항/`??`/`||` 바인딩(`const colClass = cond ? 'bg-...-tint ...' : '...'`류)을 한
 * 파일 전체에서 찾아 {변수명 → class 후보 문자열들} 표로 만든다. classStringsFromExpr가
 * 이 표를 받아 JSX className 안 Identifier/PropertyAccess/ElementAccess를 해석하므로,
 * scanContent(조상 추적)·완전성 대조(explained 합산) 양쪽이 이 표 하나를 공유해 쓴다.
 * 순방향 1-pass다(뒤에 선언된 바인딩을 참조하는 앞 선언은 못 푼다) — 실사용 16개 파일
 * 전수에서 그런 앞→뒤 순환 참조가 없음을 실행 결과로 확인(스코프 밖 명시, 아래 참고). */
export function extractLocalTintBindings(sf: ts.SourceFile): LocalTintBindingsResult {
  const bindings = new Map<string, string[]>();

  function walk(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const strings = ts.isObjectLiteralExpression(node.initializer)
        ? collectObjectLiteralClassStrings(node.initializer, bindings)
        : classStringsFromExpr(node.initializer, bindings);
      if (strings.length > 0) bindings.set(node.name.text, strings);
    }
    node.forEachChild(walk);
  }
  walk(sf);

  let accountedMatches = 0;
  for (const strings of bindings.values()) {
    for (const s of strings) {
      const m = s.match(TINT_FAMILY_BG_RE_G);
      if (m) accountedMatches += m.length;
    }
  }
  return { bindings, accountedMatches };
}

/** story #3850(AC1 축 b, doc-content-renderer.tsx류) — React JSX가 아니라 명령형 DOM
 * 코드(`el.innerHTML = ...`·`el.className = ...`)로 tint 클래스를 심는 자리. JSX 트리가
 * 없어 scanContent의 조상 추적 대상이 될 수 없다(그 문자열 자체 안에 배경·글자색이 함께
 * 박혀 있어 별도 muted 중첩 위험도 구조적으로 없다) — 완전성 explained 항에만 반영한다. */
function countAssignmentSinkTintMatches(sf: ts.SourceFile, bindings: ClassBindings): number {
  let count = 0;
  function walk(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      (node.left.name.text === 'innerHTML' || node.left.name.text === 'className')
    ) {
      for (const s of classStringsFromExpr(node.right, bindings)) {
        const m = s.match(TINT_FAMILY_BG_RE_G);
        if (m) count += m.length;
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return count;
}

/** story #3850(완전성 보강, `&&` 가드 — stuck-handoff-section.tsx 실 파일 재측정 뒤 드러남) —
 * `cond && 'bg-...-tint ...'`(clsx/cn 관용구)는 #2590 A 정밀성 그대로 조상 후보에서 뺀다
 * (조건이 거짓이면 그 클래스가 아예 안 붙어 "항상 있는 배경"으로 단정하면 위험 쪽으로
 * 틀린다 — classStringsFromExpr가 BinaryExpression을 조상 추적용으로 안 도는 이유 그대로).
 * 하지만 완전성 대조는 "가드가 이 raw 자리를 보고도 의식적으로 조상 후보에서 뺐다"와
 * "가드가 아예 못 봤다(진짜 사각)"를 구분해야 한다 — 전자를 explained로 인정해야
 * UNANALYZED_TINT_SITES가 진짜 사각(사람이 아직 안 본 새 패턴)만 남긴다. 그래서 이 축은
 * explained에만 더하고 scanContent의 실제 조상 추적(bindings)에는 절대 안 흘린다
 * (classStringsFromExpr를 bindings 없이 호출 — literal/template/ternary만, 그 자체가 이미
 * &&의 우변을 스스로 판단하지 않는다는 뜻).*/
function countAndGuardedTintMatches(sf: ts.SourceFile): number {
  let count = 0;
  function walk(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      for (const s of classStringsFromExpr(node.right)) {
        const m = s.match(TINT_FAMILY_BG_RE_G);
        if (m) count += m.length;
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return count;
}

export interface UnexplainedTintSite { file: string; raw: number; explained: number; }

export interface TreeCompletenessResult {
  componentMap: ComponentTintMap;
  /** cva variant→컴포넌트 매핑이 모호한 경우(0개/2개+) — baseline 대상 아님, 항상 하드 FAIL
   * (그 cva 정의 자체가 잘못됐다는 뜻이라 "얼려서 넘길" 채무가 아니다). */
  ambiguousReasons: string[];
  /** 파일별 원시 tint 매치 > 처리(리터럴 className + ui/ cva + 객체맵/삼항·`??`/`||` 바인딩 +
   * innerHTML/className 대입) 매치 — 이 가드가 그래도 구조적으로 못 보는 소비처(story #3839
   * PO 보강, 2026-09-14 05:48Z · 축 2개는 story #3850이 닫음). main()이 UNANALYZED_TINT_SITES
   * baseline과 비교해 늘어도·줄어도(stale) FAIL한다(신규 사각 금지). */
  unexplainedSites: UnexplainedTintSite[];
}

/** story #3839 PO 보강(2026-09-14 05:43·05:48Z) — 완전성 fail-closed를 components/ui/
 * 안에서만 도는 게 아니라 스캔 트리 «전체»로 넓힌다. 같은 메커니즘(cva나 그에 준하는
 * 클래스맵)이 ui/ 밖에 생기면 실제 조상-추적 지도(componentMap)에는 절대 안 실리므로
 * (그 지도는 ui/만 본다), 그 파일의 tint 매치는 "처리됨"으로 치지 않는다 — literal JSX
 * className만, 그리고 ui/ 파일의 cva만 "처리됨"으로 인정한다.
 *
 * story #3850(AC1) — 추가로 두 축을 explained에 합류시킨다: 객체 맵/로컬 삼항·`??`/`||`
 * 바인딩(extractLocalTintBindings — 그 바인딩을 JSX가 소비하는 지점은 classStringsFromExpr에
 * 같은 표를 넘겨 조상 후보로도 재사용, scanContent 쪽)과 innerHTML/className 명령형 대입
 * (countAssignmentSinkTintMatches). */
export function analyzeTreeForTintCompleteness(
  files: Array<{ file: string; content: string }>,
  isUiFile: (file: string) => boolean,
): TreeCompletenessResult {
  const componentMap: ComponentTintMap = new Map();
  const ambiguousReasons: string[] = [];
  const unexplainedSites: UnexplainedTintSite[] = [];

  for (const { file, content } of files) {
    const isUi = isUiFile(file);
    const cvaResult = extractCvaTintVariants(content, file);
    if (isUi) {
      mergeComponentTintMaps(componentMap, cvaResult.map);
      ambiguousReasons.push(...cvaResult.incompleteReasons);
    }

    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const { bindings, accountedMatches: localAccounted } = extractLocalTintBindings(sf);
    const assignmentSinkMatches = countAssignmentSinkTintMatches(sf, bindings);
    const andGuardedMatches = countAndGuardedTintMatches(sf);

    const literalMatches = countLiteralClassNameTintMatches(content, file);
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const raw = (stripped.match(TINT_FAMILY_BG_RE_G) ?? []).length;
    const explained =
      literalMatches + (isUi ? cvaResult.accountedMatches : 0) + localAccounted + assignmentSinkMatches + andGuardedMatches;
    if (raw > explained) {
      unexplainedSites.push({ file, raw, explained });
    }
  }
  return { componentMap, ambiguousReasons, unexplainedSites };
}

/** src 전체를 읽어 analyzeTreeForTintCompleteness에 넘긴다(uiDir 상대경로가 srcRoot 기준
 * "components/ui/"로 시작하는 파일만 ui/ 소속으로 판정). */
export function scanTreeForTintCompleteness(srcRoot: string, uiDir: string): TreeCompletenessResult {
  const absFiles: string[] = [];
  walkDir(srcRoot, absFiles);
  const uiDirRel = path.relative(srcRoot, uiDir).split(path.sep).join('/');
  const files = absFiles.map((abs) => ({
    file: path.relative(srcRoot, abs).split(path.sep).join('/'),
    content: readFileSync(abs, 'utf8'),
  }));
  return analyzeTreeForTintCompleteness(files, (file) => file.startsWith(`${uiDirRel}/`));
}

// ── JSX 스캔(조상 pale-bg 추적) ──────────────────────────────────────────────────

export interface Violation { file: string; line: number; family: TintFamily; className: string; }

export function violationKey(v: Pick<Violation, 'file' | 'family'>): string {
  return `${v.file}::muted-on-${v.family}-tint`;
}

/** componentMap이 주어지면(story #3839 카디르 보강) `<Alert variant="info">`처럼 cva
 * variant로만 tint가 나오는 컴포넌트 경계도 리터럴 `bg-info-tint` 조상과 동일하게 본다.
 * story #3850(AC1) — 같은 파일 안 객체 맵/로컬 삼항·`??`/`||` 바인딩(extractLocalTintBindings)도
 * className 해석에 함께 쓴다(`${colClass}`·`statusColor.dot`처럼 리터럴이 아닌 참조가 실제로
 * tint 배경을 끌어오는 자리를 조상으로 인식) — kanban-column.tsx류 실 소비 사례. */
export function scanContent(content: string, file: string, componentMap?: ComponentTintMap): Violation[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const { bindings } = extractLocalTintBindings(sf);
  const violations: Violation[] = [];

  function familyFromComponent(opening: ts.JsxOpeningLikeElement): TintFamily | null {
    if (!componentMap) return null;
    const tag = ts.isJsxSelfClosingElement(opening) ? opening.tagName.getText() : opening.tagName.getText();
    const axisMap = componentMap.get(tag);
    if (!axisMap) return null;
    const props = literalPropsOf(opening);
    for (const [axis, valueMap] of axisMap) {
      const value = props.get(axis);
      if (value !== undefined && valueMap.has(value)) return valueMap.get(value)!;
    }
    return null;
  }

  function walk(node: ts.Node, ancestorFamily: TintFamily | null): void {
    let opening: ts.JsxOpeningLikeElement | null = null;
    let children: ts.NodeArray<ts.JsxChild> | null = null;
    if (ts.isJsxElement(node)) { opening = node.openingElement; children = node.children; }
    else if (ts.isJsxSelfClosingElement(node)) { opening = node; }

    if (opening) {
      const cls = classNameStringsOf(opening, bindings).join(' ');
      const bgMatch = cls.match(TINT_FAMILY_BG_RE);
      // 같은 요소가 새 tint를 도입하면(같은 요소·직계/深 자식 둘 다 커버) 그 순간부터
      // «유효 조상»을 그 family로 갱신 — 같은 요소 안 bg+text 공존(같은 요소 케이스)도
      // 아래 elementFamily 판정으로 함께 잡힌다. 리터럴 클래스가 없으면 컴포넌트 지도
      // (예: <Alert variant="info">)를 본다 — 카디르 보강(2026-09-14).
      const elementFamily: TintFamily | null =
        (bgMatch?.[1] as TintFamily | undefined) ?? familyFromComponent(opening) ?? ancestorFamily;
      if (elementFamily && MUTED_TEXT_RE.test(cls)) {
        const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
        violations.push({ file, line, family: elementFamily, className: cls });
      }
      if (children) for (const c of children) walk(c, elementFamily);
      return;
    }
    node.forEachChild((c) => walk(c, ancestorFamily));
  }
  walk(sf, null);
  return violations;
}

function walkDir(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkDir(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

export function scanRepo(srcRoot: string, componentMap: ComponentTintMap): Violation[] {
  const files: string[] = [];
  walkDir(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 .tsx가 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돈다.`);
  }
  const violations: Violation[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    violations.push(...scanContent(readFileSync(abs, 'utf8'), rel, componentMap));
  }
  return violations;
}

export function countViolations(violations: Violation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of violations) {
    const key = violationKey(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// story #3839 재측정(2026-09-14 05:30Z, 카디르 컴포넌트-경계 보강 뒤 develop HEAD 재스캔,
// 23곳·45건) —
// PR #4259에 이미 반영된 activation-checklist-banner.tsx 3곳은 fix 후라 이 목록에 없다.
// 나머지는 이 스토리 스코프 밖(화면이 다르고 개별 triage 필요) 기존 채무를 그대로 얼린다.
// 신규 재유입·증가만 막고, 늘어도 줄어도(stale) FAIL — PO 승인 없이 조용히 못 움직인다.
export const GRANDFATHER_BASELINE = new Map<string, number>([
  ['app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx::muted-on-info-tint', 1],
  ['app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx::muted-on-destructive-tint', 1],
  ['app/(authenticated)/content/channel-posts/[draftId]/page.tsx::muted-on-destructive-tint', 2],
  ['app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::muted-on-info-tint', 1],
  ['app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::muted-on-success-tint', 1],
  ['app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::muted-on-warning-tint', 2],
  ['components/agents/access-matrix-tab.tsx::muted-on-success-tint', 1],
  ['components/ai/ai-generation-loading.tsx::muted-on-info-tint', 4],
  // 카디르 QA 보강(2026-09-14 05:30Z, cva variant 컴포넌트 경계 대응) 뒤 새로 보이게 된 자리 —
  // <Alert variant="destructive">(리터럴 클래스 아닌 cva 경계) 안 text-muted-foreground 5곳씩.
  ['components/content/api-usage-budget-exceeded-banner.tsx::muted-on-destructive-tint', 5],
  ['components/content/generation-budget-exceeded-banner.tsx::muted-on-destructive-tint', 5],
  // story #3850 착지(객체 맵/삼항 축 신설) 뒤 2건으로 증가 — 기존 1건(리터럴 138행)은 그대로,
  // 새로 잡힌 1건은 객체 맵 축(btn = {...}[fallback], 102행 notifying.cls가 조상으로 인식된
  // 서브트리 안 muted 텍스트). AC2 "새로 드러나는 실 위반은 목록째 카드에·오탐 처리 금지".
  ['components/cage/stuck-handoff-section.tsx::muted-on-destructive-tint', 2],
  ['components/chat/command-hint-notice.tsx::muted-on-info-tint', 1],
  ['components/chat/hitl-approval-card.tsx::muted-on-warning-tint', 3],
  ['components/chat/reference-drop-notice.tsx::muted-on-warning-tint', 2],
  ['components/docs/doc-gate-section.tsx::muted-on-destructive-tint', 1],
  ['components/epics/hypothesis-declaration-card.tsx::muted-on-info-tint', 1],
  ['components/epics/hypothesis-declaration-section.tsx::muted-on-info-tint', 1],
  ['components/hypotheses/hypothesis-verdict-card.tsx::muted-on-success-tint', 5],
  ['components/loops/context-pack-panel.tsx::muted-on-info-tint', 1],
  ['components/retro/sprint-close-cockpit.tsx::muted-on-info-tint', 3],
  ['components/settings/agent-project-access-section.tsx::muted-on-success-tint', 1],
  ['components/sprints/hypothesis-declaration-card.tsx::muted-on-info-tint', 1],
  ['components/sprints/hypothesis-declaration-section.tsx::muted-on-info-tint', 1],

  // story #3850(AC2, 2026-09-14) — 객체 맵/삼항·`??`/`||` 로컬 바인딩 축(kanban-column.tsx
  // STATUS_COLOR·colClass류)을 조상 추적에 연결한 뒤 develop HEAD 재스캔에서 새로 드러난
  // 자리(이전엔 raw 정규식이 식별자·프로퍼티 조회를 못 봐서 스캐너 시야 자체에 없었다).
  // "오탐 처리 금지" — 실제로 그 JSX 서브트리 안에 있는 text-muted-foreground이 맞다(사람이
  // 각 파일 diff로 확인, 아래 개별 근거). 개별 색상 교정은 이 스토리 스코프 밖(화면별 triage
  // 필요 — #3839 기존 grandfather와 동일 원칙)이라 그대로 얼린다.
  ['components/agents/agent-api-key-manager.tsx::muted-on-warning-tint', 1],
  ['components/cage/gate-line-context.tsx::muted-on-warning-tint', 1],
  // doc-gate-section.tsx(429행, AUDIT_META.dot 소비 span) — am.dot 바인딩이 AUDIT_META
  // 4항목의 class 후보 문자열을 전부 모아 조상 후보 판정에 쓰는데(보수적 합집합), 그 중
  // "resubmitted" 항목 자체는 안전한 bg-muted+text-muted-foreground 짝(가드의 「bg-muted
  // 자체는 대상 밖」 원칙과 같은 값)이라 그 텍스트가 다른(불안전한) 후보의 tint와 합쳐진
  // 문자열 안에서 우연히 공존한다 — 실제로는 그 span이 "resubmitted"일 때 bg-muted+
  // text-muted-foreground만 걸리고 tint는 안 걸린다(런타임에 한 후보만 선택됨). 같은
  // 요소(same-element) 공존 판정이 후보별이 아니라 합친 문자열 하나로 되는 이 가드의
  // 기존 방식(#3839부터, cn()/삼항 분기 join)의 알려진 한계 — 개별 분기 격리는 더 큰
  // 재설계가 필요해 이 스토리 스코프 밖, "오탐 처리 금지" 원칙대로 얼린다.
  ['components/docs/doc-gate-section.tsx::muted-on-info-tint', 1],
  ['components/docs/doc-status-rail.tsx::muted-on-success-tint', 2],
  // kanban-column.tsx — colClass(wipExceeded 삼항 1번째 분기 bg-destructive-tint)가 컴포넌트
  // 최상위 반환 div에 걸려, 그 밑 전체 서브트리(헤더·카드 목록 등)의 muted-foreground 11곳이
  // 전부 "조상이 destructive-tint일 수 있다"로 잡힌다 — WIP 초과 강조라는 드문 상태에서만
  // 실제로 배경이 걸리므로 상시 노출 위험은 낮지만, 가드 자신의 기존 원칙(리터럴 bg-X-tint·
  // cva variant 둘 다 "서브트리 전체"를 조상으로 본다)과 동일 규칙을 그대로 적용한 결과다
  // — 완화 규칙(예: 불투명 중간 배경이 상속을 끊는다)은 이 가드에 원래 없다(#3839부터).
  ['components/kanban/kanban-column.tsx::muted-on-destructive-tint', 11],
  ['components/org-briefing/attention-cluster-board.tsx::muted-on-warning-tint', 5],
  ['components/settings/gate-level-matrix.tsx::muted-on-success-tint', 1],
]);

// story #3839 PO 보강(2026-09-14 05:48Z) — 전 트리 완전성 대조가 잡아낸 「가드가 구조적으로
// 못 보는 tint 소비처」16곳(파일 → 원시 tint 매치 수)을 story #3850이 분석기 3축으로 닫았다:
// (a) 객체 맵 프로퍼티/첨자 조회(named const든 `{...}[key]` 인라인이든, 중첩 object도 재귀 —
//     kanban-column.tsx STATUS_COLOR·doc-gate-section.tsx AUDIT_META·gate-level-matrix.tsx·
//     attention-cluster-board.tsx·stuck-handoff-section.tsx류) (b) 삼항/템플릿 리터럴 치환식
//     안 tint·로컬 변수에 담긴 삼항/`??`/`||`(kanban-column.tsx colClass·doc-status-rail.tsx·
//     image-node.tsx·wiki-link.tsx·invite-accept-client.tsx·agent-api-key-manager.tsx·
//     channel-connect/agent-setup-section.tsx류) (c) `cond && 'bg-...-tint'` 가드·innerHTML/
//     className 명령형 대입 — 조상 후보로는 여전히 안 쓰지만(#2590 A 정밀성 유지, 조건이
//     거짓이면 안 붙을 수 있어 위험 쪽으로 단정 못 함) 가드가 "의식적으로 봤다"는 사실은
//     explained에 반영(ai-generation-loading.tsx·outcome-result-card.tsx·sprint-close-
//     cockpit.tsx·doc-content-renderer.tsx류).
//
// 사람 눈 1회 검토(2026-09-14, 미르코·가드가 잰 것 아님·지름길 명시, story #3839 원 착지 당시)
// 는 16곳 전부 "그 tint 값을 실제로 소비하는 JSX 자리"에 text-muted-foreground가 구조적으로
// 중첩되는지 이미 확인해 실 버그 0건이었다 — 이번(#3850) scanRepo 재실행(GRANDFATHER_BASELINE
// 대조)도 신규 증가 0건으로 일치, 그 결론을 가드 스스로 재확인했다.
//
// 목록은 비웠지만 남겨 둔다(신규 사각이 생기면 다시 채워지고 이 가드가 즉시 FAIL — stale
// fail-closed 계약은 그대로, GRANDFATHER_BASELINE과 동형).
export const UNANALYZED_TINT_SITES = new Map<string, number>([]);

export interface BaselineDrift { key: string; expected: number; got: number; }
export interface BaselineComparison { increased: BaselineDrift[]; stale: BaselineDrift[]; }

/** 순수 함수(no-new-alpha-text-foreground.ts와 동형 관례) — 실측 개수 맵과 baseline 맵을
 * 비교해 「초과(신규/증가)」·「미달(stale)」을 가른다. main()의 파일시스템 스캔과 분리해
 * 스캔 없이 직접 단위 테스트(뮤테이션 표본 포함)할 수 있다. */
export function compareToBaseline(actual: Map<string, number>, baseline: Map<string, number>): BaselineComparison {
  const allKeys = new Set<string>([...actual.keys(), ...baseline.keys()]);
  const increased: BaselineDrift[] = [];
  const stale: BaselineDrift[] = [];
  for (const key of allKeys) {
    const expected = baseline.get(key) ?? 0;
    const got = actual.get(key) ?? 0;
    if (got > expected) increased.push({ key, expected, got });
    else if (got < expected) stale.push({ key, expected, got });
  }
  return { increased, stale };
}

function main(): number {
  // story #3839 PO 보강(2026-09-14 05:43·05:48Z) — 완전성 fail-closed를 components/ui/
  // 안에서만 도는 게 아니라 스캔 트리 전체로 넓힌다(analyzeTreeForTintCompleteness 문서
  // 참조). 모호한 cva→컴포넌트 매핑은 항상 하드 FAIL. 구조적으로 못 보는 소비처(object맵·
  // 템플릿 삼항 등)는 UNANALYZED_TINT_SITES baseline과 대조 — 신규만 막는다(해소는 #3850).
  const { componentMap, ambiguousReasons, unexplainedSites } = scanTreeForTintCompleteness(SRC_ROOT, UI_DIR);
  if (ambiguousReasons.length > 0) {
    console.error('❌ FAIL: cva variant → 컴포넌트 매핑이 모호함(AC2 완전성 fail-closed):');
    for (const r of ambiguousReasons) console.error(`  - ${r}`);
    console.error(
      '\n이 가드는 손으로 나열한 컴포넌트 목록이 아니라 components/ui/*.tsx의 cva() 정의를 그때그때' +
        ' 읽어 지도를 만든다 — 위 cva는 그 변수를 쓰는 컴포넌트를 0개 또는 2개+로 모호하게 찾았다' +
        '(조용히 건너뛰지 않는다). cva 정의 자체를 정리할 것.',
    );
    return 1;
  }

  const actualUnanalyzed = new Map(unexplainedSites.map((s) => [s.file, s.raw] as const));
  const { increased: uIncreased, stale: uStale } = compareToBaseline(actualUnanalyzed, UNANALYZED_TINT_SITES);
  if (uIncreased.length > 0 || uStale.length > 0) {
    console.error('❌ FAIL: 「가드가 구조적으로 못 보는 tint 소비처」 목록이 baseline과 다름(AC2 완전성 fail-closed — 전 트리):');
    for (const h of uIncreased.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(
        `  - [신규/증가] ${h.key} (UNANALYZED_TINT_SITES ${h.expected}건 → 실측 ${h.got}건) — ` +
          '처방: tint 클래스를 리터럴 className/ui/의 cva로 옮기거나, PO 승인 받아 UNANALYZED_TINT_SITES에 추가할 것.',
      );
    }
    for (const h of uStale.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - [stale] ${h.key} (UNANALYZED_TINT_SITES ${h.expected}건 → 실측 ${h.got}건) — 해소됐다면 목록에서 빼거나 개수를 맞출 것.`);
    }
    return 1;
  }
  console.log(
    `[3839] cva variant → tint 지도: 컴포넌트 ${componentMap.size}개(${[...componentMap.keys()].join(', ')}) · ` +
      `unanalyzed tint sites ${UNANALYZED_TINT_SITES.size}곳(정확 일치)`,
  );

  const violations = scanRepo(SRC_ROOT, componentMap);
  const actual = countViolations(violations);
  const { increased, stale } = compareToBaseline(actual, GRANDFATHER_BASELINE);

  const total = [...actual.values()].reduce((a, b) => a + b, 0);
  console.log(
    `[3839] tint 배경 위 text-muted-foreground 스캔 — 고유 자리 ${actual.size}건 · ` +
      `총 발생 ${total}건 · grandfather 등재 ${GRANDFATHER_BASELINE.size}건`,
  );

  if (increased.length === 0 && stale.length === 0) {
    console.log('\nOK: tint 배경 위 text-muted-foreground 개수가 grandfather와 정확히 일치(신규 0·stale 0).');
    return 0;
  }

  if (increased.length > 0) {
    console.error(`\n❌ 신규/증가한 tint-위-muted 자리 ${increased.length}건 — text-foreground로 바꿀 것(story #3839 재발):`);
    for (const h of increased.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${h.key} (grandfather ${h.expected}건 → 실측 ${h.got}건)`);
    }
  }
  if (stale.length > 0) {
    console.error(`\n❌ stale grandfather ${stale.length}건 — 실제 개수가 등재값보다 적다(고쳤다면 목록에서 개수를 맞출 것):`);
    for (const h of stale.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${h.key} (grandfather ${h.expected}건 → 실측 ${h.got}건)`);
    }
  }
  console.error(
    '\ntint 배경(destructive/info/success/warning -tint·-bg — 리터럴 className 또는 cva variant' +
      ' 경계 둘 다) 위 text-muted-foreground는 AA 미달(ink-3는 --muted 배경 기준으로만 조정된 값) —' +
      ' text-foreground를 쓴다(#2420 규율과 같은 축). GRANDFATHER_BASELINE의 개수는 항상 실측과' +
      ' 정확히 일치해야 한다(늘어도·줄어도 FAIL — PO 승인 없이 조용히 못 움직인다).',
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
