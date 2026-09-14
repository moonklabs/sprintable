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

// story #3865(AC1) — kanban-column.tsx 실측(globals.css 그라운딩): 이 5개 배경 토큰은 알파
// 0(완전 불투명) 솔리드 색이다 — `--card: var(--proof-panel)`·`--popover: var(--proof-panel)`·
// `--sidebar: var(--proof-panel)`·`--background: var(--proof-bg)`·`--proof-panel` 자체가
// 라이트/다크 둘 다 `#RRGGBB` 리터럴(알파 채널 없음). 이런 불투명 배경을 가진 요소는 그
// 위에 실제로 렌더되는 것이 그 배경색이지, 조상에서 물려받은 tint가 아니다(비쳐 보이지
// 않는다) — 조상 tint 전파를 이 요소에서 끊는다. `/숫자` 알파 접미사가 붙으면(`bg-card/50`류)
// 더 이상 완전 불투명이 아니므로 매치 대상에서 제외(음성 lookahead에 `/` 포함).
const OPAQUE_BG_CLASSES = ['card', 'popover', 'sidebar', 'background', 'proof-panel'] as const;
const OPAQUE_BG_RE = new RegExp(`(?<![\\w:-])bg-(?:${OPAQUE_BG_CLASSES.join('|')})(?![\\w/-])`);

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

/** story #3865(AC1, PO CHANGES 2026-09-14 11:40Z «같은 조건식=같은 세계») — className
 * 속성의 원본 표현식(AST) 그 자체를 돌려준다(classNameStringsOf처럼 문자열로 납작하게
 * 만들지 않음) — 같은 조건식 여부 비교엔 원본 조건 노드가 필요하다. 리터럴 문자열
 * className(조건 자체가 없음)이면 null. */
function classNameExprOf(opening: ts.JsxOpeningLikeElement): ts.Expression | null {
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === 'className' && a.initializer) {
      if (ts.isJsxExpression(a.initializer) && a.initializer.expression) return a.initializer.expression;
    }
  }
  return null;
}

/** story #3865(AC1, PO CHANGES 2026-09-14 11:40Z) — 조건식 하나가 tint(조상)를 켜는 것과
 * 같은 조건식이 muted(자손)를 켜는 것이 실제로는 같은 축(같은 변수)일 수 있다
 * (kanban-column.tsx colClass·자식 클래스가 둘 다 `wipExceeded`). 이 경우 그룹 정밀화
 * (classGroupsFromExpr)만으로는 못 잡는다 — 그룹 정밀화는 "같은 요소" 공존만 다루고,
 * 이건 "조상-자손 간" 조건 일치다. `predicate`를 만족하는 분기와 그 분기를 고르는
 * 조건의 소스 텍스트를 찾아 돌려준다(condition이 단순 Identifier/PropertyAccess일 때만
 * — 복잡한 식은 비교 신뢰 불가라 null, 기존 보수적 동작으로 폴백). 중첩 삼항 체인
 * (colClass류 — 첫 조건 거짓 분기가 또 삼항)은 거짓 분기를 계속 타고 내려가며 찾는다
 * (참 분기 재귀는 안 함 — #2590 A 정밀성과 동형, 첫 매치 조건만 신뢰). */
interface ConditionMatch { conditionText: string; matchesWhenTrue: boolean }

function findConditionForClasses(
  e: ts.Expression,
  initializers: ReadonlyMap<string, ts.Expression>,
  bindings: ClassBindings,
  sf: ts.SourceFile,
  predicate: (classes: string[]) => boolean,
): ConditionMatch | null {
  if (ts.isParenthesizedExpression(e)) return findConditionForClasses(e.expression, initializers, bindings, sf, predicate);
  if (ts.isIdentifier(e)) {
    const init = initializers.get(e.text);
    return init ? findConditionForClasses(init, initializers, bindings, sf, predicate) : null;
  }
  if (ts.isTemplateExpression(e)) {
    for (const sp of e.templateSpans) {
      const found = findConditionForClasses(sp.expression, initializers, bindings, sf, predicate);
      if (found) return found;
    }
    return null;
  }
  if (ts.isConditionalExpression(e)) {
    const cond = e.condition;
    const simple = ts.isIdentifier(cond) || ts.isPropertyAccessExpression(cond);
    if (simple && predicate(classStringsFromExpr(e.whenTrue, bindings))) {
      return { conditionText: cond.getText(sf), matchesWhenTrue: true };
    }
    if (simple && predicate(classStringsFromExpr(e.whenFalse, bindings))) {
      return { conditionText: cond.getText(sf), matchesWhenTrue: false };
    }
    return findConditionForClasses(e.whenFalse, initializers, bindings, sf, predicate);
  }
  return null;
}

/** story #3865(AC1, PO 조건②·2026-09-14 11:04Z) — 「같은 삼항/바인딩의 두 분기끼리만
 * 상호배타, 서로 다른(독립) 축끼리는 곱집합(동시 적용 가능·fail-closed)」을 표현하는
 * 구조. `always`는 무조건 적용되는 정적 조각들(템플릿 head/literal 등). `groups`는 서로
 * 독립인 "선택 축" 목록 — 같은 배열(같은 그룹) 안 후보들은 정확히 하나만 런타임에
 * 선택되지만(삼항 한 개·바인딩 조회 한 개가 곧 그룹 하나), 서로 다른 그룹은 각자
 * 독립적으로 결정되므로 동시에 같이 적용될 수 있다(예: `cn(condA?'a-tint':'x',
 * condB?'muted':'y')` — condA·condB가 둘 다 참이면 두 그룹의 후보가 동시에 붙는다). */
interface ClassGroups { always: string[]; groups: string[][] }

function classGroupsFromExpr(e: ts.Expression, bindings: ClassBindings): ClassGroups {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { always: [e.text], groups: [] };
  if (ts.isParenthesizedExpression(e)) return classGroupsFromExpr(e.expression, bindings);
  if (ts.isTemplateExpression(e)) {
    const always: string[] = [e.head.text];
    const groups: string[][] = [];
    for (const sp of e.templateSpans) {
      always.push(sp.literal.text);
      // 각 치환식 «전체»가 독립 축 하나 — 내부가 삼항/바인딩으로 아무리 복잡해도 그
      // 전체가 최종적으로 문자열 하나로 귀결되므로, classStringsFromExpr(기존 flat
      // 재귀)로 그 축의 후보 전부를 모아 그룹 하나에 싣는다. 서로 다른 치환식(축)끼리는
      // 이 함수가 별도 그룹으로 쌓으므로 곱집합으로 취급된다(PO 조건②).
      const candidates = classStringsFromExpr(sp.expression, bindings);
      if (candidates.length > 0) groups.push(candidates);
    }
    return { always, groups };
  }
  if (ts.isCallExpression(e) && /(?:^|\.)cn$/.test(e.expression.getText())) {
    // cn()의 인자들은 서로 독립이다(PO 조건②) — 인자 하나가 그 자체로 삼항/바인딩이면
    // classGroupsFromExpr 재귀가 그 축을 그룹 하나로 돌려주고, 여러 인자에 걸쳐 그 그룹들을
    // 그대로 이어 붙인다(인자 간 상호배타 가정 0 — 각자 독립 조건일 수 있으므로).
    const always: string[] = [];
    const groups: string[][] = [];
    for (const a of e.arguments) {
      if (!ts.isExpression(a)) continue;
      const sub = classGroupsFromExpr(a, bindings);
      always.push(...sub.always);
      groups.push(...sub.groups);
    }
    return { always, groups };
  }
  if (ts.isConditionalExpression(e)) {
    // 삼항 전체(중첩 포함)=하나의 배타적 선택 축 — 양 분기의 후보 전부(내부가 아무리
    // 깊어도 최종 문자열은 하나)를 그룹 하나에 모은다.
    const candidates = [...classStringsFromExpr(e.whenTrue, bindings), ...classStringsFromExpr(e.whenFalse, bindings)];
    return { always: [], groups: candidates.length > 0 ? [candidates] : [] };
  }
  if (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const candidates = [...classStringsFromExpr(e.left, bindings), ...classStringsFromExpr(e.right, bindings)];
    return { always: [], groups: candidates.length > 0 ? [candidates] : [] };
  }
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    // 바인딩(객체 맵 등) 조회 전체 = 하나의 배타적 선택 축(그 변수는 런타임에 값 하나로
    // 확정) — 기존 flat 해석기를 재사용해 그 축의 후보 전부를 그룹 하나에 싣는다.
    const candidates = classStringsFromExpr(e, bindings);
    return { always: [], groups: candidates.length > 0 ? [candidates] : [] };
  }
  return { always: [], groups: [] };
}

function classNameGroupsOf(opening: ts.JsxOpeningLikeElement, bindings: ClassBindings = NO_BINDINGS): ClassGroups {
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === 'className' && a.initializer) {
      if (ts.isStringLiteral(a.initializer)) return { always: [a.initializer.text], groups: [] };
      if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
        return classGroupsFromExpr(a.initializer.expression, bindings);
      }
    }
  }
  return { always: [], groups: [] };
}

/** story #3865(AC1) — 같은 요소가 스스로 tint를 선언한 경우(ownFamily), muted와의 공존을
 * "합친 문자열 전체"가 아니라 이 그룹 구조로 정밀 판정한다: 같은 그룹(같은 삼항/바인딩)의
 * 같은 후보 문자열 안에 tint+muted가 함께 있으면 위반(실제로 같이 렌더될 수 있는 조합).
 * 서로 다른 두 그룹(독립 축)이 각각 tint·muted를 가지면 — 한쪽만이 아니라 둘 다 참일 수
 * 있으므로(fail-closed) — 이것도 위반으로 본다(PO 조건②, 2026-09-14 11:04Z). always(무조건
 * 적용되는 정적 부분)에 있는 tint/muted는 모든 그룹과 무조건 동시 적용되므로 즉시 위반. */
function sameElementCoOccurs(g: ClassGroups): boolean {
  const alwaysHasTint = g.always.some((s) => TINT_FAMILY_BG_RE.test(s));
  const alwaysHasMuted = g.always.some((s) => MUTED_TEXT_RE.test(s));
  if (alwaysHasTint && alwaysHasMuted) return true;

  const groupHasTint = g.groups.map((grp) => grp.some((s) => TINT_FAMILY_BG_RE.test(s)));
  const groupHasMuted = g.groups.map((grp) => grp.some((s) => MUTED_TEXT_RE.test(s)));
  const groupHasBoth = g.groups.map((grp) => grp.some((s) => TINT_FAMILY_BG_RE.test(s) && MUTED_TEXT_RE.test(s)));

  if (groupHasBoth.some(Boolean)) return true; // 같은 그룹의 같은 후보 문자열 안 공존
  if (alwaysHasTint && groupHasMuted.some(Boolean)) return true;
  if (alwaysHasMuted && groupHasTint.some(Boolean)) return true;

  for (let i = 0; i < g.groups.length; i++) {
    for (let j = 0; j < g.groups.length; j++) {
      if (i !== j && groupHasTint[i] && groupHasMuted[j]) return true; // 서로 다른 독립 축의 곱집합
    }
  }
  return false;
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
  /** story #3865(AC1, PO CHANGES 2026-09-14 11:40Z) — varName → 그 변수의 초기화 표현식
   * 원본 AST(문자열로 납작하게 만들지 않음). findConditionForClasses가 「같은 조건식」
   * 비교를 위해 조건 노드 자체를 재귀 추적할 때 쓴다(bindings의 흐름 그대로, 별도 표). */
  initializers: Map<string, ts.Expression>;
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
  const initializers = new Map<string, ts.Expression>();

  function walk(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const strings = ts.isObjectLiteralExpression(node.initializer)
        ? collectObjectLiteralClassStrings(node.initializer, bindings)
        : classStringsFromExpr(node.initializer, bindings);
      if (strings.length > 0) {
        bindings.set(node.name.text, strings);
        initializers.set(node.name.text, node.initializer);
      }
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
  return { bindings, accountedMatches, initializers };
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

/** story #3865(AC1) — 한 파일 안에서 "최상위 함수/화살표 컴포넌트의 반환 JSX 서브트리
 * «어딘가»가 완전 불투명 배경(OPAQUE_BG_RE, 리터럴 className) 또는 이미 opaque로 알려진
 * 컴포넌트 태그(priorOpaque — 다른 파일에서 먼저 발견된 것, 고정점 반복의 이전 라운드
 * 결과)를 만난다"를 찾아 컴포넌트 이름 집합으로 돌려준다.
 *
 * kanban-column.tsx가 렌더하는 `<StoryCard>`는 자기 자신의 루트 className에 불투명 배경이
 * 없다(`<div className="group relative cursor-pointer transition">`) — 실제 불투명 배경은
 * 그 안에서 렌더하는 `<ProofCapsule>`(다른 파일)의 루트에 있다. 그래서 "루트 하나만" 보지
 * 않고 반환 서브트리 전체를 훑되, priorOpaque로 이미 알려진 이름을 만나면 그 전체 컴포넌트
 * (StoryCard)도 opaque로 표시한다 — buildOpaqueComponentSet이 이 함수를 빈 집합→고정점까지
 * 반복 호출해 ProofCapsule(1라운드)→StoryCard(2라운드)처럼 여러 단 합성을 따라간다.
 *
 * ⚠️정밀도 한계(의도적, 안전 쪽 과근사) — 반환 서브트리 "어딘가"에 불투명 지점이 있으면
 * 컴포넌트 전체를 opaque로 본다. 한 컴포넌트가 불투명 영역과 비-불투명 영역을 형제로 함께
 * 갖는 드문 경우 그 비-불투명 쪽의 실 위반을 놓칠 수 있다 — 이 가드의 다른 축(예: `&&` 가드
 * 완전성 스킵)과 같은 결의 트레이드오프, kanban-column.tsx 실사례(StoryCard=ProofCapsule
 * 단일 컨텐츠)에서는 해당 안 됨. forwardRef/일반 함수 선언·화살표 함수(블록·단일 표현식
 * 바디) 전부 커버. */
export function findOpaqueRootComponents(content: string, file: string, priorOpaque: ReadonlySet<string> = new Set()): Set<string> {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set<string>();

  function subtreeIsOpaque(body: ts.Node): boolean {
    let found = false;
    function visit(n: ts.Node): void {
      if (found) return;
      let opening: ts.JsxOpeningLikeElement | null = null;
      if (ts.isJsxElement(n)) opening = n.openingElement;
      else if (ts.isJsxSelfClosingElement(n)) opening = n;
      if (opening) {
        const cls = classNameStringsOf(opening, NO_BINDINGS).join(' ');
        if (OPAQUE_BG_RE.test(cls) || priorOpaque.has(opening.tagName.getText())) { found = true; return; }
      }
      n.forEachChild(visit);
    }
    visit(body);
    return found;
  }

  function walk(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text) && node.body) {
      if (subtreeIsOpaque(node.body)) names.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z]/.test(node.name.text) && node.initializer) {
      let init: ts.Expression = node.initializer;
      // forwardRef((props, ref) => ...)류 — 마지막 인자가 컴포넌트 본체인 관용구 1단만 벗긴다.
      if (ts.isCallExpression(init) && init.arguments.length > 0) {
        const last = init.arguments[init.arguments.length - 1];
        if (last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last))) init = last;
      }
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && subtreeIsOpaque(init.body)) {
        names.add(node.name.text);
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return names;
}

/** findOpaqueRootComponents를 트리 전체(components/ 한정 없이 srcRoot 전체 — StoryCard는
 * components/kanban/, ProofCapsule은 components/proof-capsule/처럼 어디에나 있을 수 있다)로
 * 확장하고, StoryCard→ProofCapsule 같은 다단 합성을 따라가도록 고정점까지 반복한다(집합이
 * 더 안 늘면 종료 — 상한 8라운드로 fail-safe, 실전 합성 깊이는 통상 2~3단). */
export function buildOpaqueComponentSet(srcRoot: string): Set<string> {
  const files: string[] = [];
  walkDir(srcRoot, files);
  const fileContents = files.map((abs) => ({
    rel: path.relative(srcRoot, abs).split(path.sep).join('/'),
    content: readFileSync(abs, 'utf8'),
  }));

  let names = new Set<string>();
  const MAX_ROUNDS = 8;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = new Set(names);
    for (const { rel, content } of fileContents) {
      for (const n of findOpaqueRootComponents(content, rel, names)) next.add(n);
    }
    if (next.size === names.size) break; // 고정점 도달(더 안 늘어남)
    names = next;
  }
  return names;
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
 * tint 배경을 끌어오는 자리를 조상으로 인식) — kanban-column.tsx류 실 소비 사례.
 * story #3865(AC1) — opaqueComponents가 주어지면(buildOpaqueComponentSet), `<StoryCard>`처럼
 * 그 자신은 불투명 배경 className이 없어도 내부(다른 파일)에서 완전 불투명 배경을 입는
 * 것으로 알려진 컴포넌트 경계에서 조상 tint 전파를 끊는다(불투명 배경 위엔 tint가 비쳐
 * 보이지 않는다). */
export function scanContent(
  content: string,
  file: string,
  componentMap?: ComponentTintMap,
  opaqueComponents?: ReadonlySet<string>,
): Violation[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const { bindings, initializers } = extractLocalTintBindings(sf);
  const violations: Violation[] = [];
  const isTintMatch = (classes: string[]) => classes.some((c) => TINT_FAMILY_BG_RE.test(c));
  const isMutedMatch = (classes: string[]) => classes.some((c) => MUTED_TEXT_RE.test(c));

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

  function isOpaqueComponentBoundary(opening: ts.JsxOpeningLikeElement): boolean {
    if (!opaqueComponents) return false;
    const tag = opening.tagName.getText();
    return opaqueComponents.has(tag);
  }

  // story #3865(AC1, PO CHANGES 2026-09-14 11:40Z «같은 조건식=같은 세계») — 조상이
  // 어떤 조건식으로 tint를 켰는지(conditionText)까지 함께 나른다. kanban-column.tsx의
  // colClass(`wipExceeded ? destructive-tint : ...`)와 자식의 자기 className
  // (`wipExceeded ? text-foreground : text-muted-foreground`)이 **같은 조건식**을 쓰면,
  // tint가 뜰 때(wipExceeded=true)는 자식도 정확히 그 순간 ink 분기를 고르므로 실제
  // 공존은 0 — 조건식이 다르거나(독립 축) 단순 식이 아니면 기존 보수적 판정(어디든
  // muted가 있으면 위반, fail-closed)으로 폴백한다.
  // conditionText가 있을 때만 유효(null이면 matchesWhenTrue는 의미 없음 — 항상 false로 둔다).
  interface Ancestor { family: TintFamily; conditionText: string | null; matchesWhenTrue: boolean }

  function walk(node: ts.Node, ancestor: Ancestor | null): void {
    let opening: ts.JsxOpeningLikeElement | null = null;
    let children: ts.NodeArray<ts.JsxChild> | null = null;
    if (ts.isJsxElement(node)) { opening = node.openingElement; children = node.children; }
    else if (ts.isJsxSelfClosingElement(node)) { opening = node; }

    if (opening) {
      const parts = classNameStringsOf(opening, bindings);
      const cls = parts.join(' ');
      const bgMatch = cls.match(TINT_FAMILY_BG_RE);
      // 같은 요소가 새 tint를 도입하면(같은 요소·직계/深 자식 둘 다 커버) 그 순간부터
      // «유효 조상»을 그 family로 갱신 — 같은 요소 안 bg+text 공존(같은 요소 케이스)도
      // 아래 elementFamily 판정으로 함께 잡힌다. 리터럴 클래스가 없으면 컴포넌트 지도
      // (예: <Alert variant="info">)를 본다 — 카디르 보강(2026-09-14).
      const ownFamily = (bgMatch?.[1] as TintFamily | undefined) ?? familyFromComponent(opening);
      // story #3865(AC1) — 이 요소 자신이 tint를 도입하지 않았는데 완전 불투명 배경
      // (OPAQUE_BG_RE, 리터럴 className) 또는 불투명 배경을 입는 것으로 알려진 컴포넌트
      // 경계(opaqueComponents, 다른 파일의 컴포넌트 루트)를 만나면, 그 위에 실제로 보이는
      // 것은 이 불투명색이지 조상에서 물려받은 tint가 아니다(비쳐 보이지 않음) — 물려받은
      // ancestor를 여기서 끊는다(kanban-column.tsx의 StoryCard→ProofCapsule
      // bg-proof-panel류 실사례).
      const breaksOpaque = OPAQUE_BG_RE.test(cls) || isOpaqueComponentBoundary(opening);
      const elementFamily: TintFamily | null = ownFamily ?? (breaksOpaque ? null : ancestor?.family ?? null);
      // 이 요소 자신이 새로 tint를 도입했으면(리터럴 className일 수도 있어 classNameExprOf가
      // null일 수 있다 — 그럴 땐 조건식이 없으므로 비교 불가=null) 그 tint를 켜는 조건식을
      // 찾는다(colClass류 — 단순 Identifier/PropertyAccess 조건일 때만 신뢰).
      const ownExpr = classNameExprOf(opening);
      const ownTintCondition = ownFamily && ownExpr
        ? findConditionForClasses(ownExpr, initializers, bindings, sf, isTintMatch)
        : null;
      const elementAncestorForChildren: Ancestor | null = elementFamily
        ? ownFamily
          ? { family: elementFamily, conditionText: ownTintCondition?.conditionText ?? null, matchesWhenTrue: ownTintCondition?.matchesWhenTrue ?? true }
          : (breaksOpaque ? null : ancestor) // ancestor 그대로 승계(조건식 정보도 함께)
        : null;
      // story #3865(AC1, doc-gate-section.tsx AUDIT_META 실사례·PO 조건②) — ownFamily가
      // "이 요소 자신의" 선언(리터럴 또는 바인딩 해석)에서 나온 경우, muted 공존은
      // sameElementCoOccurs(그룹 구조 — 같은 삼항/바인딩끼리만 상호배타, 서로 다른 독립
      // 축은 곱집합)로 정밀 판정한다. 바인딩(예: am.dot)이 서로 배타적인 여러 후보를 가질
      // 때(런타임엔 한 후보만 선택됨), 안전한 후보(bg-muted+text-muted-foreground)의
      // 텍스트가 다른 후보의 tint와 «같은 그룹 안»에서 우연히 공존 판정되는 것은 막되,
      // 서로 다른 두 개의 독립 조건(예: cn(condA?tint:x, condB?muted:y))은 여전히 위반으로
      // 잡는다(fail-closed). ancestor에서 물려받은 경우(ownFamily 없음)는 이 요소 자신엔
      // tint가 없고 조상에만 있으므로(다른 DOM 노드) 기존처럼 어디든 muted가 있으면 위반
      // — 단, 조상의 tint 조건식과 이 요소 자신의 className 조건식이 **같은 소스 텍스트**면
      // (조건②, PO CHANGES 2026-09-14 11:40Z — kanban-column.tsx wipExceeded 실사례) 그 둘이
      // 진짜 같은 축인지 분기 대응까지 확인한다: tint를 켜는 분기(matchesWhenTrue)와 이
      // 요소가 muted를 켜는 분기가 다르면(엇갈리면) tint 뜨는 순간엔 muted가 없다=안전.
      let sameElementMuted: boolean;
      if (ownFamily) {
        sameElementMuted = sameElementCoOccurs(classNameGroupsOf(opening, bindings));
      } else if (ancestor?.conditionText && ownExpr) {
        const descendantMatch = findConditionForClasses(ownExpr, initializers, bindings, sf, isMutedMatch);
        sameElementMuted =
          descendantMatch && descendantMatch.conditionText === ancestor.conditionText
            ? descendantMatch.matchesWhenTrue === ancestor.matchesWhenTrue
            : MUTED_TEXT_RE.test(cls);
      } else {
        sameElementMuted = MUTED_TEXT_RE.test(cls);
      }
      if (elementFamily && sameElementMuted) {
        const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
        violations.push({ file, line, family: elementFamily, className: cls });
      }
      if (children) for (const c of children) walk(c, elementAncestorForChildren);
      return;
    }
    node.forEachChild((c) => walk(c, ancestor));
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
  // story #3865(AC1) — 불투명-루트 컴포넌트 지도도 한 번만 만들어 전 파일 스캔에 공유(cva
  // 컴포넌트 지도와 동형 관례).
  const opaqueComponents = buildOpaqueComponentSet(srcRoot);
  const violations: Violation[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    violations.push(...scanContent(readFileSync(abs, 'utf8'), rel, componentMap, opaqueComponents));
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
  // story #3865(AC1·조건①②, PO 확定 2026-09-14 11:04Z) — 같은 요소 tint+muted 공존 판정을
  // "합친 문자열 전체"에서 "그룹 단위"(같은 삼항/바인딩의 분기끼리만 상호배타, 독립 축은
  // 곱집합 유지)로 정밀화한 뒤 develop HEAD 재스캔에서 stale로 드러난 8곳 — 전부 실 파일
  // 대조로 "삼항/바인딩 두 분기가 각각 tint·muted를 갖지만 런타임엔 한쪽만 선택돼 실제
  // 공존 0"인 동일 클래스로 확인(아래 각 줄 근거, PR 본문에 표로도 정리). recruiter-
  // client.tsx muted-on-info-tint 1건은 별도로 불투명 배경 규칙(OPAQUE_BG_RE·
  // buildOpaqueComponentSet) 신설로도 걷혔다(그 자리는 opaque 컴포넌트 경계 안).
  //
  // channel-posts/[draftId]/page.tsx — 실측: destructive-tint(에러 배너류)와 muted-
  // foreground(기본 상태 캡션류)가 같은 조건 분기의 서로 다른 값이라 동시 렌더 0.
  // 제거만·색 변경 0(이 스토리 스코프 밖 화면, 코드 무접촉).
  ['app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::muted-on-success-tint', 1],
  ['app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::muted-on-warning-tint', 2],
  // access-matrix-tab.tsx(232행) — `granted ? 'border-success/40 bg-success-tint text-success…'
  // : 'border-border text-muted-foreground…'`(cn() 삼항 한 개) — granted가 참/거짓 중
  // 정확히 하나만 골라 tint·muted가 같은 시점에 같이 안 붙는다(실 파일 대조, PR 본문 근거
  // 줄). 제거만·색 변경 0(스코프 밖, 코드 무접촉).
  ['components/ai/ai-generation-loading.tsx::muted-on-info-tint', 4],
  // 카디르 QA 보강(2026-09-14 05:30Z, cva variant 컴포넌트 경계 대응) 뒤 새로 보이게 된 자리 —
  // <Alert variant="destructive">(리터럴 클래스 아닌 cva 경계) 안 text-muted-foreground 5곳씩.
  ['components/content/api-usage-budget-exceeded-banner.tsx::muted-on-destructive-tint', 5],
  ['components/content/generation-budget-exceeded-banner.tsx::muted-on-destructive-tint', 5],
  // story #3865(AC1 정밀화 뒤 2→1) — 걷힌 1건(102행 notifying.cls 객체맵 축)은 doc-gate-
  // section류와 동형 오탐(그룹 정밀화로 해소). 남은 1건(138-141행) — bg-destructive-tint
  // literal div(withdraw==='confirming') 안 Cancel 버튼이 text-muted-foreground — 실 위반
  // 확인(조상 상속 케이스, 그룹 무관). 별 카드 기재 예정·이 PR 색 변경 0.
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
  // agent-project-access-section.tsx — 삼항/바인딩 두 분기가 각각 tint·muted를 가져 런타임
  // 공존 0(실 파일 대조). 제거만·색 변경 0(스코프 밖, 코드 무접촉).
  ['components/sprints/hypothesis-declaration-card.tsx::muted-on-info-tint', 1],
  ['components/sprints/hypothesis-declaration-section.tsx::muted-on-info-tint', 1],

  // story #3850(AC2, 2026-09-14) — 객체 맵/삼항·`??`/`||` 로컬 바인딩 축(kanban-column.tsx
  // STATUS_COLOR·colClass류)을 조상 추적에 연결한 뒤 develop HEAD 재스캔에서 새로 드러난
  // 자리 — story #3865(AC1 정밀화)가 이 절 전체를 재검토, 각 파일 실측 근거는 아래.
  //
  // agent-api-key-manager.tsx(305행) — `s === 'admin' ? 'bg-warning-tint text-warning-strong'
  // : 'bg-muted text-muted-foreground'`(템플릿 치환 안 삼항 한 개) — 같은 삼항의 두 분기라
  // 런타임 공존 0. 제거만·색 변경 0(스코프 밖, 코드 무접촉).
  //
  // gate-line-context.tsx(89행 부근) — 삼항 한 개의 두 분기가 각각 tint·muted, 런타임
  // 공존 0(실 파일 대조). 제거만·색 변경 0(스코프 밖, 코드 무접촉).
  //
  // doc-gate-section.tsx(429행) — AUDIT_META 4항목을 am.dot으로 조회(객체맵 바인딩 한
  // 그룹) — "resubmit" 항목만 안전한 bg-muted+text-muted-foreground 짝이고 나머지 3항목
  // (tint)엔 muted가 아예 없다 — 같은 그룹 안 같은 후보에 공존 0. 제거만·색 변경 0(#3865
  // AC0①, PO 확定).
  //
  // doc-status-rail.tsx(2곳)·kanban-column.tsx(11곳) — 둘 다 실 위반으로 확인돼
  // text-foreground로 교정(#3865 AC0②③) — baseline에서 완전히 제거.
  //
  // attention-cluster-board.tsx — 정밀화로 5→1. 걷힌 4건은 같은 삼항/바인딩 그룹 안
  // 상호배타 분기(실 파일 대조). 남은 1건(279행 ChevronDown, bucket.style.rowBg 조상
  // 서브트리 안 상시 렌더 아이콘)은 실 위반 확인 — 별 카드 기재 예정·이 PR 색 변경 0.
  ['components/org-briefing/attention-cluster-board.tsx::muted-on-warning-tint', 1],
  // gate-level-matrix.tsx(268행) — `selected ? LEVEL_META[lv].selected : 'border-border
  // text-muted-foreground hover:bg-muted/40'`(삼항 한 개 — true 분기가 LEVEL_META 객체맵
  // 조회, false 분기가 리터럴 muted) — 같은 삼항이 곧 같은 그룹이라 LEVEL_META의 3개
  // tint 후보(auto/ask/block)와 false 분기의 muted 후보가 같은 그룹 안에 모이지만, 그
  // 그룹의 어느 «한» 후보 문자열도 tint+muted를 동시에 담지 않는다(각자 순수 tint 또는
  // 순수 muted) — 같은 삼항=상호배타라 실제 공존 0(실 파일 대조). 제거만·색 변경 0
  // (스코프 밖, 코드 무접촉).
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
