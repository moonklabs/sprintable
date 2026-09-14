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

function classStringsFromExpr(e: ts.Expression): string[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) {
    return [[e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)].join(' ')];
  }
  if (ts.isCallExpression(e) && /(?:^|\.)cn$/.test(e.expression.getText())) {
    // #2590 A(verify-cross-element-tint-text.ts)와 달리 재귀 처리한다 — 실사고
    // (activation-checklist-banner.tsx)가 정확히 `cn('...', met ? 'a' : 'b')` 형태라,
    // cn() 인자가 문자열 리터럴일 때만 보면 그 삼항이 통째로 빠져 정작 막으려던 자리를
    // 못 잡는다(뮤테이션 테스트가 이 구멍을 실측으로 잡아냈다). 인자별로 재귀해 삼항의
    // 두 branch 모두 수집 — && 등 그 외 조건부는 classStringsFromExpr가 여전히 []로 제외.
    return e.arguments.flatMap((a) => classStringsFromExpr(a));
  }
  if (ts.isConditionalExpression(e)) {
    return [...classStringsFromExpr(e.whenTrue), ...classStringsFromExpr(e.whenFalse)];
  }
  return []; // BinaryExpression(x && 'y') 등 조건부 = 항상적용 보장 안 됨 → 제외(정밀, #2590 A 관례 그대로).
}

function classNameStringsOf(opening: ts.JsxOpeningLikeElement): string[] {
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === 'className' && a.initializer) {
      if (ts.isStringLiteral(a.initializer)) return [a.initializer.text];
      if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
        return classStringsFromExpr(a.initializer.expression);
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

export interface UnexplainedTintSite { file: string; raw: number; explained: number; }

export interface TreeCompletenessResult {
  componentMap: ComponentTintMap;
  /** cva variant→컴포넌트 매핑이 모호한 경우(0개/2개+) — baseline 대상 아님, 항상 하드 FAIL
   * (그 cva 정의 자체가 잘못됐다는 뜻이라 "얼려서 넘길" 채무가 아니다). */
  ambiguousReasons: string[];
  /** 파일별 원시 tint 매치 > 처리(리터럴 className + ui/ cva) 매치 — object맵·템플릿 삼항
   * 등 이 가드가 구조적으로 못 보는 소비처(story #3839 PO 보강, 2026-09-14 05:48Z). main()이
   * UNANALYZED_TINT_SITES baseline과 비교해 늘어도·줄어도(stale) FAIL한다(신규 사각 금지,
   * 해소는 story #3850). */
  unexplainedSites: UnexplainedTintSite[];
}

/** story #3839 PO 보강(2026-09-14 05:43·05:48Z) — 완전성 fail-closed를 components/ui/
 * 안에서만 도는 게 아니라 스캔 트리 «전체»로 넓힌다. 같은 메커니즘(cva나 그에 준하는
 * 클래스맵)이 ui/ 밖에 생기면 실제 조상-추적 지도(componentMap)에는 절대 안 실리므로
 * (그 지도는 ui/만 본다), 그 파일의 tint 매치는 "처리됨"으로 치지 않는다 — literal JSX
 * className만, 그리고 ui/ 파일의 cva만 "처리됨"으로 인정한다. */
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

    const literalMatches = countLiteralClassNameTintMatches(content, file);
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const raw = (stripped.match(TINT_FAMILY_BG_RE_G) ?? []).length;
    const explained = literalMatches + (isUi ? cvaResult.accountedMatches : 0);
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
 * variant로만 tint가 나오는 컴포넌트 경계도 리터럴 `bg-info-tint` 조상과 동일하게 본다. */
export function scanContent(content: string, file: string, componentMap?: ComponentTintMap): Violation[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
      const cls = classNameStringsOf(opening).join(' ');
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
  ['components/cage/stuck-handoff-section.tsx::muted-on-destructive-tint', 1],
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
]);

// story #3839 PO 보강(2026-09-14 05:48Z) — 전 트리 완전성 대조가 잡아낸 「가드가 구조적으로
// 못 보는 tint 소비처」16곳(파일 → 원시 tint 매치 수). 전부 object맵(status→className 조회,
// 예: kanban-column.tsx·gate-level-matrix.tsx·doc-gate-section.tsx의 AUDIT_META) 또는
// 템플릿 리터럴 안 삼항(예: invite-accept-client.tsx)이라 cva 파싱과 다른 두 축의 분석기가
// 필요 — story #3850(별 카드)이 그 분석기를 만들어 이 목록을 16→0으로 줄인다.
//
// 사람 눈 1회 검토(2026-09-14, 미르코·가드가 잰 것 아님·지름길 명시) — 16곳 전부 "그 tint
// 값을 실제로 소비하는 JSX 자리"에 text-muted-foreground가 구조적으로 중첩되는지 직접
// 대조: 전부 형제 요소이거나 별도 표시줄이라 실 muted-on-tint 중첩 버그 0건. (doc-gate-
// section.tsx는 예외 — 그 파일의 리터럴 bg-destructive-tint div(396행) 안 text-muted-
// foreground(399행)는 이미 GRANDFATHER_BASELINE에 잡혀있는 별개의 실 위반이고, object맵
// AUDIT_META.dot 소비처(429행 span)는 그 위반과 무관한 형제 요소 — 이 목록의 "3건 미처리"는
// AUDIT_META의 dot 값 자체가 아직 지도 밖이라는 뜻일 뿐.)
//
// 늘어도·줄어도(stale) FAIL — 정확히 일치해야 GREEN(GRANDFATHER_BASELINE과 동형 계약).
export const UNANALYZED_TINT_SITES = new Map<string, number>([
  ['app/invite/accept/invite-accept-client.tsx', 2],
  ['components/agents/agent-api-key-manager.tsx', 1],
  ['components/ai/ai-generation-loading.tsx', 2],
  ['components/cage/gate-line-context.tsx', 2],
  ['components/cage/stuck-handoff-section.tsx', 2],
  ['components/channel-connect/agent-setup-section.tsx', 2],
  ['components/docs/doc-content-renderer.tsx', 3],
  ['components/docs/doc-gate-section.tsx', 4],
  ['components/docs/doc-status-rail.tsx', 3],
  ['components/docs/extensions/image-node.tsx', 1],
  ['components/docs/extensions/wiki-link.tsx', 1],
  ['components/kanban/kanban-column.tsx', 5],
  ['components/org-briefing/attention-cluster-board.tsx', 5],
  ['components/outcome/outcome-result-card.tsx', 1],
  ['components/retro/sprint-close-cockpit.tsx', 4],
  ['components/settings/gate-level-matrix.tsx', 3],
]);

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
