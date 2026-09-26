// story #4226(PO 판단 23:19Z · 까디르 QA cd595a263) — `?p=` 없이 flat 목적지로 가는 앱 내부 이동의 래칫.
// flat 목적지 = `app/(authenticated)` 아래 `[` 로 시작하지 않는 최상위 폴더(새 flat 라우트가 생기면 자동 포함).
// 셈법은 정규식이 아니라 **TypeScript 컴파일러 AST**.
// story #4231 3차(PO 02:02Z) — 예전 셈법은 «이동 자리 모양»(JSX href · router.push/replace · `href:`/`path:`)만 봐서, href 헬퍼의 `return` ·
//   `window.location.href/assign` · 다른 이름 prop(`targetRoute`·`conversationHref`·`secondaryHref`) · 상수로 만든 목적지를 못 셌다(≈30곳).
//   이제는 **flat 리터럴이 어디에 있든 센다**(템플릿은 머리 글자 · 조건식은 갈래마다). 세지 않는 것은 셋뿐이다:
//   ① 감싼 자리 — `flatHref(…)`·`withProjectParam(…)`·`withProject(…)`·`useConnectRulesHref(…)` 호출 안 — 이름이 아니라 **선언 출처**로 판정(아래 TRUSTED_EXPORTS).
//   ①' 리터럴이 스스로 프로젝트를 싣는 자리 — 해시(#) 앞 쿼리에 `p` **키**가 있음(예: 결재 자기 프로젝트로 가는 `/gates/${id}?p=${projectId}` · #4241).
//       글자가 아니라 키로 본다 — `?q=?p=x`(q의 값) · `#?p=x`(해시 안)는 런타임이 p를 붙이는 자리라 그대로 센다(까디르 QA P3).
//   ② 이동이 아닌 자리 — 구조로 판정(비교 연산 · `case` · `startsWith`류 판정 · 탭 정체성 인자 · 정적 파일 fetch)하거나,
//      아래 EXEMPT 표에 **이유와 함께** 적은 자리(파일 + 리터럴/속성). 표는 늘리지 않는 것이 원칙이다(새 예외는 PO 판단).
// 이 수는 **문법 전수**(소스에 쓰인 flat 리터럴)이지 런타임 링크 전수가 아니다(한 리터럴이 여러 링크를 그릴 수 있고, 조건 갈래는 따로 센다).
// 이 수가 **늘면 RED**(새 bare flat 목적지 금지). 줄였으면 BASELINE도 같이 낮출 것(래칫) — #4231이 0까지 내린다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { MIGRATED_RESOURCES } from './legacy-resource-tables';
import { describe, expect, it } from 'vitest';

const BASELINE = 0;

const SRC = path.resolve(__dirname, '..');
const AUTH = path.join(SRC, 'app/(authenticated)');
// 이동이 아닌 호출의 인자(구조 판정) — 탭 정체성(useSyntheticParentTabHistory: 어느 탭 소속인지 표시 · 이동 아님) · 정적 파일 fetch.
const NON_NAV_CALLEES = new Set(['useSyntheticParentTabHistory', 'fetch']);
const PREDICATE_METHODS = new Set(['startsWith', 'endsWith', 'includes', 'indexOf', 'match', 'test']);
// story #4231 다음 조각(래칫 맹점 ③ · 까디르 4614 codex P2) — 옛 자원 · flat 경로를 **조립하는 헬퍼**. 리터럴이 헬퍼 안(`/${resource}`)에
// 있어 머리 글자로는 못 셌다. 이 헬퍼 호출 = flat 목적지로 센다 — 인자에 프로젝트를 싣는 함수(선언 출처로 판정)가 있을 때만 세지 않는다.
const ASSEMBLERS = new Set(['scopedResourceHref', 'destHref', 'resolveTabHref']);
// story #4231 마지막 조각 — 폴백 경로를 **받아서 감싸는** 헬퍼(계약상 감싸는 함수가 필수 인자). 리터럴은 호출 자리에선 bare로 보이지만
// 헬퍼가 그 함수로 감싸 내보낸다(`resolveScopedEntityHref(slugs, '/board?story=…', build, withProject)` — #4253 «폴백은 bare로 못 나간다» ·
// entity-project-url.test.ts가 감쌈을 고정). 감싸는 인자가 실제로 프로젝트를 싣는 함수일 때만 그 폴백 리터럴을 세지 않는다.
// 이름만 같은 가짜(파일 안에 같은 이름을 새로 선언)를 막으려고 **그 모듈에서 가져온** 이름일 때만 쓴다.
const WRAPPING_HELPERS: ReadonlyMap<string, { module: string; fallbackArg: number; wrapperArg: number }> = new Map([
  ['resolveScopedEntityHref', { module: '@/lib/entity-project-url', fallbackArg: 1, wrapperArg: 3 }],
]);

/** 이동이 아니거나(판정·서버·문맥 전) 감싸면 틀리는 자리 — 파일(SRC 기준) + 리터럴(템플릿은 머리 글자). props가 있으면 그 속성 값일 때만. */
export const EXEMPT: ReadonlyArray<{ file: string; texts?: string[]; props?: string[]; reason: string }> = [
  { file: 'lib/nav-config.ts', props: ['path'], reason: '내비 설정 경로 — 소비처(사이드바·더보기·탭바·커맨드 팔레트)가 렌더에서 flatHref로 감싼다(각 flat-href 렌더 테스트)' },
  { file: 'lib/nav-v3-destinations.ts', props: ['path'], reason: 'v3 목적지 설정 경로 — 클라이언트 소비처(탭바·nav-v3-item-list·chat-v3 «오늘»·온보딩 첫 착지·온보딩 첫 지시 redirect)가 감싸고, 나머지는 서버 리다이렉트(proxy·app/page·desktop·dashboard/page·auth callback)' },
  { file: 'components/command-palette/command-palette.tsx', props: ['href'], reason: 'GUARD_ANCHOR_ITEMS 설정 경로(데이터 표) — 소비처 deriveNavigateItems가 resolveResourceHref(scopedResourceHref)로 `/{ws}/{proj}/…` 직접 주소를 만든다(slug 모르면 flat + ?p=) · #4274 뒤 · nav-scoped-resource-links 가드가 헬퍼 결과 href로 고정' },
  { file: 'hooks/use-account-switcher.ts', reason: '다른 조직으로 전환하는 하드 이동 — 현재 프로젝트를 실으면 틀린 p(PO 02:02Z 예외)' },
  { file: 'app/dashboard/dashboard-shell.tsx', texts: ['/glance', '/inbox', '/chats', '/more'], reason: 'TAB_ROOT_PREFIXES — 경로 접두 판정 표(이동 아님 · /glance는 #4231 4차에서 옛 자원 경로가 flat 목적지에 들며 드러남)' },
  { file: 'proxy.ts', reason: '미들웨어 경로 판정(이동 링크 아님)' },
  { file: 'lib/nav-v3-destinations.ts', texts: ['/chats'], reason: 'resolveChatsHref 플래그 없을 때의 대화 목적지 — 앱 안 CTA는 useChatsHref가 감싸고, 나머지 호출처는 서버(session-redirect)·문맥 전 착지(mfa·invite·onboarding)' },
  { file: 'components/content/content-rule-violation.tsx', texts: ['/organization/content-rules'], reason: 'BE settings_path와 맞대는 비교 기준 상수 — 이동은 useConnectRulesHref(감쌈)로만' },
  // 아래 예외는 «p를 실으면 안 된다»가 아니라 «이 자리엔 실을 목표 프로젝트 값이 없다(클라이언트 훅 밖)»는 뜻이다.
  { file: 'app/api/oauth-channel/authorize/route.ts', reason: '서버 리다이렉트(로그인 뒤 돌아올 next) — 서버엔 클라이언트의 목표 프로젝트가 없다(들어온 주소의 p는 이어질 수 있음)' },
  { file: 'app/auth/link/route.ts', reason: '서버 리다이렉트(로그인 뒤 돌아올 next) — 서버엔 클라이언트의 목표 프로젝트가 없다(들어온 주소의 p는 이어질 수 있음)' },
  { file: 'app/dashboard/settings/page.tsx', reason: '서버 리다이렉트(옛 주소 → /settings) — 서버엔 클라이언트의 목표 프로젝트가 없다(착지 뒤 셸이 정한다)' },
  { file: 'app/(authenticated)/organization/connectors/page.tsx', reason: '서버 리다이렉트(옛 주소) — 서버엔 클라이언트의 목표 프로젝트가 없다(착지 뒤 셸이 정한다)' },
  { file: 'app/register/page.tsx', reason: '가입 직후 첫 착지 — 아직 프로젝트 컨텍스트가 없어 실을 값이 없다' },
  { file: 'app/verify-email/page.tsx', reason: '이메일 확인 직후 첫 착지 — 아직 프로젝트 컨텍스트가 없어 실을 값이 없다' },
  { file: 'components/auth/session-expired-dialog.tsx', reason: '재로그인 뒤 돌아올 경로(현재 주소 폴백) — 로그인 전이라 실을 값이 없다' },
  { file: 'components/nav/mobile-tab-bar.tsx', texts: ['destHref'], props: ['href'], reason: 'TABS/V3_TABS 모듈 상수의 구운 href(단위테스트 계약) — 실제 렌더 href는 MobileTabBar가 resolveTabHref(…, flatHref)로 매 렌더 다시 구한다' },
];

// story #4231 4차(PO 07:48Z) — 옛 자원 경로(MIGRATED_RESOURCES — /board · /sprints · /storage …)도 flat 목적지다. proxy가 그 자리를 scoped로
// 리다이렉트할 때 링크의 `?p=`로 프로젝트를 정한다(#4253). 예전 자는 `app/(authenticated)` 최상위 폴더만 세서, 이 경로로 가는 bare 링크
// (flow 예외 스트림 `/board?story=` 70건 등)를 한 번도 못 셌다.
function flatRoutes(): string[] {
  const dirs = readdirSync(AUTH).filter((d) => !d.startsWith('[') && statSync(path.join(AUTH, d)).isDirectory());
  return [...new Set([...dirs, ...Object.keys(MIGRATED_RESOURCES)])].sort();
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.includes('.test.') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return null;
}

// ── 심볼 해석(까디르 QA 4679 CHANGES) ─────────────────────────────────────────────────────────────────────────────
// 예전엔 «프로젝트를 싣는 함수»를 **이름**으로 믿었다: ① 파일 안 가짜 `const flatHref = (h) => h`도 감싼 것으로 통과 ② 팩토리를 파일의 **첫**
// 선언으로 찾아 가려진(shadowed) 안쪽 `mk()`를 못 봄 ③ 감싸는 헬퍼의 import를 **파일 단위**로 봐 같은 파일 안 중첩 로컬 같은 이름도 통과.
// 이제 호출 자리의 식별자가 **실제로 가리키는 선언**(가장 가까운 스코프부터 바깥으로)을 찾고, 그 선언의 출처로 판정한다.
//
// 믿는 출처(소스 전수 조사 · 이 밖은 전부 못 믿음):
//  · withProjectParam — `lib/with-project-param`에서 import(또는 그 재수출 `hooks/use-flat-href`) · 그 파일 안 선언 자체.
//  · projectHref — `components/org-briefing/derive-attention-clusters`에서 import · 그 파일 안 선언.
//  · useConnectRulesHref — `app/dashboard/dashboard-shell`에서 import · 그 파일 안 선언.
//  · flatHref(이름 무관) — `const x = useFlatHref()`(useFlatHref가 `hooks/use-flat-href`에서 import) · 그 값의 `useRef(x).current` · `const y = x` 별칭.
//  · withProject — 헬퍼의 **매개변수**(계약: 호출자가 프로젝트를 싣는 함수를 필수로 넘긴다). 스스로 못 잡는 것(자인): 그 헬퍼의 호출자가
//    실제로 무엇을 넘기는지는 이 가드가 따라가지 않는다 — 호출자 쪽 인자 자리는 위 판정으로 따로 센다(ASSEMBLERS · 감싸는 헬퍼).
const TRUSTED_EXPORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['withProjectParam', ['lib/with-project-param', 'hooks/use-flat-href']],
  ['projectHref', ['components/org-briefing/derive-attention-clusters']],
  ['useConnectRulesHref', ['app/dashboard/dashboard-shell']],
  ['useFlatHref', ['hooks/use-flat-href']],
]);
const TRUSTED_PARAMS = new Set(['withProject']);

function bindingIds(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingIds(el.name)));
}

/** 이 스코프 노드가 **직접** 선언한 `name`(없으면 undefined). var 끌어올림은 근사(같은 블록만). */
function declaredIn(scope: ts.Node, name: string): ts.Node | undefined {
  const inStatements = (statements: readonly ts.Statement[]): ts.Node | undefined => {
    for (const st of statements) {
      if (ts.isImportDeclaration(st) && st.importClause) {
        const c = st.importClause;
        if (c.name?.text === name) return c;
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings) && c.namedBindings.name.text === name) return c.namedBindings;
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
          const el = c.namedBindings.elements.find((e) => e.name.text === name);
          if (el) return el;
        }
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          const hit = bindingIds(d.name).find((i) => i.text === name);
          if (hit) return ts.isIdentifier(d.name) ? d : hit.parent;
        }
      }
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === name) return st;
    }
    return undefined;
  };
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    return inStatements(scope.statements);
  }
  if (ts.isFunctionLike(scope)) {
    for (const prm of scope.parameters) {
      const hit = bindingIds(prm.name).find((i) => i.text === name);
      if (hit) return ts.isIdentifier(prm.name) ? prm : hit.parent;
    }
    if (ts.isFunctionExpression(scope) && scope.name?.text === name) return scope;
  }
  if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
    && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
    for (const d of scope.initializer.declarations) if (bindingIds(d.name).some((i) => i.text === name)) return d;
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingIds(scope.variableDeclaration.name).some((i) => i.text === name)) {
    return scope.variableDeclaration;
  }
  return undefined;
}

/** 식별자가 실제로 가리키는 선언 — 가장 가까운 스코프부터 바깥으로(가려진 이름은 안쪽이 이긴다). 못 찾으면(전역 등) undefined. */
export function resolveBinding(id: ts.Identifier): ts.Node | undefined {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    const d = declaredIn(n, id.text);
    if (d) return d;
  }
  return undefined;
}

/** 모듈 지정자 → SRC 기준 경로(확장자 없음). `@/x` · 상대 경로만(패키지는 null). */
function moduleKey(sf: ts.SourceFile, spec: string): string | null {
  const noExt = (p: string) => p.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
  if (spec.startsWith('@/')) return noExt(spec.slice(2));
  if (spec.startsWith('.')) return noExt(path.relative(SRC, path.resolve(path.dirname(path.resolve(SRC, sf.fileName)), spec)).split(path.sep).join('/'));
  return null;
}

function fileKey(sf: ts.SourceFile): string {
  return path.relative(SRC, path.resolve(SRC, sf.fileName)).split(path.sep).join('/').replace(/\.(tsx?)$/, '');
}

/** 선언이 믿는 내보내기(이름 · 모듈)인가 — import(이름 바꿔 가져와도 원래 이름으로) 또는 그 모듈 안 선언 자체. */
function isTrustedExport(decl: ts.Node | undefined, exportName: string): boolean {
  const modules = TRUSTED_EXPORTS.get(exportName);
  if (!decl || !modules) return false;
  if (ts.isImportSpecifier(decl)) {
    const imported = (decl.propertyName ?? decl.name).text;
    const spec = decl.parent.parent.parent.moduleSpecifier;
    const key = ts.isStringLiteral(spec) ? moduleKey(decl.getSourceFile(), spec.text) : null;
    return imported === exportName && key !== null && modules.includes(key);
  }
  if ((ts.isFunctionDeclaration(decl) || ts.isVariableDeclaration(decl)) && decl.name && ts.isIdentifier(decl.name)
    && decl.name.text === exportName) {
    return modules.includes(fileKey(decl.getSourceFile()));
  }
  return false;
}

/** 식별자가 «프로젝트를 싣는 함수»를 가리키나 — 이름이 아니라 선언의 출처로(위 표). */
function isTrustedWrapperId(id: ts.Identifier, depth = 0): boolean {
  if (depth > 4) return false;
  const decl = resolveBinding(id);
  if (!decl) return false;
  for (const name of ['withProjectParam', 'projectHref', 'useConnectRulesHref']) if (isTrustedExport(decl, name)) return true;
  if (ts.isParameter(decl) && ts.isIdentifier(decl.name) && TRUSTED_PARAMS.has(decl.name.text)) return true;
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;
    // const flatHref = useFlatHref()
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && isTrustedExport(resolveBinding(init.expression), 'useFlatHref')) return true;
    // const y = flatHref(별칭)
    if (ts.isIdentifier(init)) return isTrustedWrapperId(init, depth + 1);
    // const f = ref.current — ref = useRef(flatHref)
    if (ts.isPropertyAccessExpression(init) && init.name.text === 'current' && ts.isIdentifier(init.expression)) {
      const refDecl = resolveBinding(init.expression);
      const refInit = refDecl && ts.isVariableDeclaration(refDecl) ? refDecl.initializer : undefined;
      if (refInit && ts.isCallExpression(refInit) && ts.isIdentifier(refInit.expression) && refInit.expression.text === 'useRef'
        && refInit.arguments[0] && ts.isIdentifier(refInit.arguments[0])) {
        return isTrustedWrapperId(refInit.arguments[0], depth + 1);
      }
    }
  }
  return false;
}

/** `name`이 호출 자리에서 이 모듈에서 가져온 그 이름을 가리키나(가려진 로컬 · 파일 안 다른 선언은 아니다). */
function resolvesToImport(id: ts.Identifier, module: string): boolean {
  const decl = resolveBinding(id);
  if (!decl || !ts.isImportSpecifier(decl)) return false;
  const spec = decl.parent.parent.parent.moduleSpecifier;
  return (decl.propertyName ?? decl.name).text === id.text && ts.isStringLiteral(spec) && spec.text === module;
}

/** 리터럴이 해시(#) 앞 쿼리에 `p` 키를 스스로 싣는지(템플릿은 머리 + 각 조각 꼬리 · 치환 자리는 \u0000). 키 판정은 withProjectParam과 같은 뜻. */

/** 함수가 돌려주는 식(화살표 식 본문 · return 문)들. */
function returnedExpressions(fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isReturnStatement(n)) { if (n.expression) out.push(n.expression); return; }
    if (ts.isFunctionLike(n)) return; // 안쪽 함수의 return은 이 함수의 결과가 아니다.
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return out;
}

/** 호출 자리에서 보이는 `callee` 선언(스코프 따라 · 가려진 안쪽이 이긴다)이 함수면 그 함수. 까디르 QA ②: 예전엔 파일의 **첫** 선언. */
function visibleFunctionDecl(callee: ts.Identifier): ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | null {
  const d = resolveBinding(callee);
  if (!d) return null;
  if (ts.isFunctionDeclaration(d)) return d;
  if (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
  return null;
}

/**
 * 인자가 «프로젝트를 싣는 함수»인가 — ① 선언 출처가 믿는 함수인 식별자 ② 본문이 그런 함수를 부르는 화살표 ③ 호출 자리에서 보이는 **팩토리 호출**로,
 * 그 팩토리가 돌려주는 모든 갈래(조건식 양쪽)가 ①·② 중 하나일 때(embed-card `ownProjectHref`: 항목 p를 싣는 화살표 · 없으면 flatHref).
 * 항등 `(h) => h` · 모르는 이름 · 항등을 돌려주는 팩토리는 아니다.
 */
function isProjectCarryingFn(arg: ts.Expression | undefined, depth = 0): boolean {
  if (!arg || depth > 3) return false;
  if (ts.isParenthesizedExpression(arg)) return isProjectCarryingFn(arg.expression, depth);
  if (ts.isConditionalExpression(arg)) return isProjectCarryingFn(arg.whenTrue, depth) && isProjectCarryingFn(arg.whenFalse, depth);
  if (ts.isIdentifier(arg)) return isTrustedWrapperId(arg);
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    const results = returnedExpressions(arg);
    return results.length > 0 && results.every((r) => isWrapperCall(r));
  }
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
    const decl = visibleFunctionDecl(arg.expression);
    if (!decl) return false;
    const results = returnedExpressions(decl);
    return results.length > 0 && results.every((r) => isProjectCarryingFn(r, depth + 1));
  }
  return false;
}

/** 리터럴이 감싸는 헬퍼의 폴백 인자 자리이고, 그 호출이 프로젝트를 싣는 함수를 넘기는가. */
function isWrappedFallback(node: ts.Node): boolean {
  const { child, parent } = effectiveParent(node);
  if (!parent || !ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression)) return false;
  const spec = WRAPPING_HELPERS.get(parent.expression.text);
  if (!spec || parent.arguments[spec.fallbackArg] !== child) return false;
  // 까디르 QA ③ — 파일에 import가 있어도, 호출 자리의 이름이 가려진 로컬(중첩 선언)이면 그 헬퍼가 아니다.
  if (!resolvesToImport(parent.expression, spec.module)) return false;
  return isProjectCarryingFn(parent.arguments[spec.wrapperArg]);
}

function carriesOwnProject(node: ts.Node): boolean {
  const fixed = ts.isTemplateExpression(node)
    ? node.head.text + node.templateSpans.map((sp) => '\u0000' + sp.literal.text).join('')
    : (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : '';
  const beforeHash = fixed.split('#')[0];
  const q = beforeHash.indexOf('?');
  if (q < 0) return false;
  return beforeHash.slice(q + 1).split('&').some((pair) => pair.split('=')[0] === 'p');
}

// story #4296(까디르 4639 codex · PO 08:16Z) — 머리 글자로 세는 셈법의 맹점 ④: 목적지가 **데이터**에서 오는 템플릿(`/${item.path}` ·
// `/${resource}`)은 머리가 `/` 하나라 flat 목적지로 안 보였다(«전체» 메뉴 자원 항목이 bare로 나간 자리). 머리가 `/`뿐이고 첫 치환이
// 경로 · 자원을 담는 이름(`path` · `resource`로 끝나는 식별자나 속성)이면 flat 목적지로 센다. scoped 조립(`/${ws}/${proj}/…`)은 첫 치환이
// 조직 · 프로젝트라 세지 않는다.
const DATA_PATH_NAME = /(?:^|[a-z])(?:path|resource)$/i;

function isDataPathTemplate(node: ts.Node): boolean {
  if (!ts.isTemplateExpression(node) || node.head.text !== '/') return false;
  const first = node.templateSpans[0]?.expression;
  if (!first) return false;
  const name = ts.isIdentifier(first) ? first.text : ts.isPropertyAccessExpression(first) ? first.name.text : null;
  return name !== null && DATA_PATH_NAME.test(name);
}

function isWrapperCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && isTrustedWrapperId(node.expression);
}

/** 조건식 갈래·괄호·`??`·`||`를 거슬러 올라간 뒤의 부모(리터럴이 실제로 쓰이는 자리). */
function effectiveParent(node: ts.Node): { child: ts.Node; parent: ts.Node | undefined } {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent && (ts.isParenthesizedExpression(parent)
    || (ts.isConditionalExpression(parent) && parent.condition !== child)
    || (ts.isBinaryExpression(parent) && (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)))) {
    child = parent;
    parent = parent.parent;
  }
  return { child, parent };
}

/** 리터럴이 이동이 아닌 구조(비교 · case · 판정 메서드 · 이동 아닌 호출 인자) 안에 있는지. */
function isStructurallyNonNav(node: ts.Node): boolean {
  const { parent } = effectiveParent(node);
  if (!parent) return false;
  if (ts.isBinaryExpression(parent)) {
    const k = parent.operatorToken.kind;
    return k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken
      || k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken;
  }
  if (ts.isCaseClause(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && PREDICATE_METHODS.has(parent.name.text)) return true;
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    if (ts.isPropertyAccessExpression(callee) && PREDICATE_METHODS.has(callee.name.text)) return true;
    if (ts.isIdentifier(callee) && NON_NAV_CALLEES.has(callee.text)) return true;
  }
  return false;
}

/** 리터럴이 값으로 들어간 객체 속성 이름(없으면 null) — 예외 표의 props 판정용. */
function enclosingPropName(node: ts.Node): string | null {
  const { parent } = effectiveParent(node);
  if (parent && ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) return parent.name.text;
  return null;
}

function isExempt(rel: string, text: string, prop: string | null): boolean {
  return EXEMPT.some((e) => e.file === rel
    && (!e.texts || e.texts.includes(text))
    && (!e.props || (prop !== null && e.props.includes(prop))));
}

export function countBareFlatLinksInSource(fileName: string, text: string, routes: string[], rel = fileName): number {
  const flatRe = new RegExp(`^/(${routes.map((r) => r.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})(?=[/?#]|$)`);
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (isWrapperCall(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ASSEMBLERS.has(node.expression.text)) {
      const wrapped = node.arguments.some((a) => ts.isIdentifier(a) && isProjectCarryingFn(a));
      if (!wrapped && !isExempt(rel, node.expression.text, enclosingPropName(node))) n += 1;
    }
    const literal = literalText(node);
    if (literal !== null) {
      const flat = flatRe.test(literal) || isDataPathTemplate(node);
      if (flat && !carriesOwnProject(node) && !isWrappedFallback(node) && !isStructurallyNonNav(node) && !isExempt(rel, literal, enclosingPropName(node))) n += 1;
      if (!ts.isTemplateExpression(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

function countBareFlatLinks(): { total: number; byFile: Record<string, number> } {
  const routes = flatRoutes();
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    const n = countBareFlatLinksInSource(file, readFileSync(file, 'utf8'), routes, rel);
    if (n) { byFile[rel] = n; total += n; }
  }
  return { total, byFile };
}

describe('`?p=` 없는 flat 목적지 래칫(story #4226 → #4231 · TS AST 셈법)', () => {
  const routes = ['inbox', 'chats', 'gates', 'more', 'organization', 'docs', 'settings'];
  // 까디르 QA 4679 — 감싸기 함수는 이제 **선언 출처**로 판정한다. 표본은 실제 소스처럼 진짜 import · `useFlatHref()`에서 받은 flatHref를
  // 앞에 둔다(countRaw는 이 머리 없이 — 가짜 선언 · 가려진 이름 표본용).
  const PRELUDE = "import { useFlatHref } from '@/hooks/use-flat-href';\nimport { withProjectParam } from '@/lib/with-project-param';\nconst flatHref = useFlatHref();\n";
  const count = (src: string, rel = 'x.tsx') => countBareFlatLinksInSource('x.tsx', PRELUDE + src, routes, rel);
  const countRaw = (src: string) => countBareFlatLinksInSource('x.tsx', src, routes, 'x.tsx');

  it('양성대조 — 이동 자리 모양(JSX href · router · href:/path:) · 조건식 갈래마다', () => {
    expect(count('const a = <Link href="/inbox?tab=gates" />;')).toBe(1);
    expect(count('const a = <Link href={cond ? todayHref : `/gates/${id}`} />;')).toBe(1);
    expect(count('const a = <Link href={cond ? "/chats" : `/gates/${id}`} />;')).toBe(2);
    expect(count('router.push (`/chats/${id}`);')).toBe(1);
    expect(count('router.push(\n  compose ? `/chats/${c}?compose=${x}` : `/chats/${c}`,\n);')).toBe(2);
    expect(count("this.props.router.replace('/more');")).toBe(1);
    expect(count("const nav = [{ id: 'more', path: '/more' }, { href: '/organization/events' }];")).toBe(2);
  });

  it('⭐#4231 4차 — 옛 자원 경로(MIGRATED_RESOURCES)도 flat 목적지로 센다(/board · /sprints · /storage …)', () => {
    const real = flatRoutes();
    for (const name of ['board', 'sprints', 'storage', 'flow', 'glance', 'standup']) expect(real).toContain(name);
  });

  it('⭐양성대조(#4231 3차 사각지대) — 헬퍼 return · 하드 이동 · 다른 이름 prop · 상수 · 기본값', () => {
    expect(count("function hrefFor(id) { return id ? `/gates/${id}` : '/inbox?tab=gates'; }")).toBe(2);
    expect(count('window.location.href = `/docs/${slug}`;')).toBe(1);
    expect(count("window.location.assign('/settings?tab=organization');")).toBe(1);
    expect(count("const a = { targetRoute: '/inbox?tab=gates' };")).toBe(1);
    expect(count('const a = <Proof conversationHref={`/chats/${c}?messageId=${m}`} />;')).toBe(1);
    expect(count("export const SETTINGS_PATH = '/organization/content-rules';")).toBe(1);
    expect(count("function View({ backHref = '/chats' }) { return null; }")).toBe(1);
  });

  it('음성대조 — 감싼 자리 · scoped 경로 · flat이 아닌 접두 · 이동이 아닌 구조', () => {
    expect(count("const a = <Link href={flatHref('/inbox?tab=gates')} />;")).toBe(0);
    expect(count('const a = <Link href={flatHref(cond ? "/chats" : `/gates/${id}`)} />;')).toBe(0);
    expect(count("const a = withProjectParam('/settings?tab=members', projectId);")).toBe(0);
    expect(count('const a = <Link href={`/${ws}/${proj}/flow`} />;')).toBe(0);
    expect(count('const a = <Link href="/inboxes" />;')).toBe(0);
    expect(count("if (pathname === '/chats') {}")).toBe(0);
    expect(count("const on = pathname !== '/chats' && pathname.startsWith('/chats/');")).toBe(0);
    expect(count("switch (p) { case '/inbox': break; }")).toBe(0);
    expect(count("useSyntheticParentTabHistory('/more');")).toBe(0);
    expect(count("fetch('/docs/manifest.json');")).toBe(0);
  });

  it('⭐스스로 프로젝트를 싣는 리터럴(고정 글자에 ?p= · &p=)은 세지 않는다 — 비슷한 모양은 그대로 센다', () => {
    expect(count('const h = pid ? `/gates/${id}?p=${encodeURIComponent(pid)}` : `/gates/${id}`;')).toBe(1);
    expect(count('const h = `/inbox?tab=gates&p=${pid}`;')).toBe(0);
    expect(count("const h = '/chats?p=abc';")).toBe(0);
    expect(count('const h = `/gates/${id}?pp=${x}`;')).toBe(1);
    expect(count('const h = `/gates/${id}?tab=p=${x}`;')).toBe(1);
    expect(count('const h = `/chats/${id}?q=${p}`;')).toBe(1);
    // 까디르 QA P3 — 글자가 아니라 키: 다른 키의 값 안 · 해시 안의 `?p=`는 실은 게 아니다(런타임이 p를 붙이는 자리).
    expect(count("const h = '/chats?q=?p=placeholder';")).toBe(1);
    expect(count('const h = `/chats?tab=x#?p=${pid}`;')).toBe(1);
    expect(count("const h = '/chats#section?p=x';")).toBe(1);
    expect(count("const h = '/chats#section';")).toBe(1); // 해시로 바로 이어지는 flat 목적지도 센다(경계 [/?#])
  });

  it('⭐#4231 다음 조각(맹점 ③) — 조립 헬퍼 호출은 프로젝트를 싣는 함수를 넘길 때만 세지 않는다', () => {
    expect(count("const h = scopedResourceHref('flow', org, proj, flatHref);")).toBe(0);
    expect(count("const h = scopedResourceHref('flow', org, proj, keepHref);")).toBe(1);
    expect(count('const h = destHref(dest, scope, flatHref);')).toBe(0);
    expect(count('const h = destHref(dest, scope, (h) => h);')).toBe(1);
    expect(count('function f(withProject) { return resolveTabHref(tab, dest, scope, withProject); }')).toBe(0);
    expect(count("const TABS = [{ href: destHref(D.work, {}, keepHref) }];", 'components/nav/mobile-tab-bar.tsx')).toBe(0);
    expect(count("const x = destHref(D.work, {}, keepHref);", 'components/nav/mobile-tab-bar.tsx')).toBe(1);
  });

  it('⭐#4296 맹점 ④ — 데이터에서 오는 경로 템플릿(`/${item.path}` · `/${resource}`)도 flat 목적지로 센다', () => {
    // 양성: «전체» 메뉴가 자원 항목을 bare로 내보내던 바로 그 줄 모양 · 이름이 path/resource로 끝나는 치환.
    expect(count("const href = item.kind === 'static' ? flatHref(item.path) : `/${item.path}`;")).toBe(1);
    expect(count('const h = `/${resource}`;')).toBe(1);
    expect(count('router.push(`/${dest.resourcePath}?tab=x`);')).toBe(1);
    // 음성: 감싼 자리 · 스스로 p를 싣는 자리 · scoped 조립(첫 치환이 조직 · 프로젝트) · path가 아닌 치환 · 비교.
    expect(count('function f(withProject) { return withProject(`/${resource}`); }')).toBe(0);
    expect(count('const h = `/${item.path}?p=${pid}`;')).toBe(0);
    expect(count('const h = `/${orgSlug}/${projectSlug}/${resource}`;')).toBe(0);
    expect(count('const h = `/${slug}`;')).toBe(0);
    expect(count('const h = `/${item.pathname}`;')).toBe(0);
    expect(count('if (href === `/${item.path}`) {}')).toBe(0);
  });

  it('⭐#4231 마지막 조각 — 감싸는 헬퍼의 폴백 리터럴은 감싸는 인자가 프로젝트를 싣는 함수일 때만 세지 않는다', () => {
    // 양성 — 감싸는 인자가 없거나 · 항등 · 모르는 이름이면 bare 폴백으로 센다.
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst h = resolveScopedEntityHref(s, `/docs?id=${id}`, build);')).toBe(1);
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst h = resolveScopedEntityHref(s, `/docs?id=${id}`, build, (h) => h);')).toBe(1);
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst h = resolveScopedEntityHref(s, `/gates/${id}`, build, keep);')).toBe(1);
    // 폴백 자리가 아닌 인자에 둔 flat 리터럴은 그대로 센다.
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst h = resolveScopedEntityHref(s, null, () => `/docs?id=${id}`, flatHref);')).toBe(1);
    // 음성 — 프로젝트를 싣는 함수(이름 · 팩토리 · 그 함수를 부르는 화살표) · 조건식 폴백 갈래.
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst h = resolveScopedEntityHref(s, `/docs?id=${id}`, build, flatHref);')).toBe(0);
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst ownProjectHref = (pid) => (pid ? (h) => withProjectParam(h, pid) : flatHref);\nconst h = resolveScopedEntityHref(s, `/gates/${id}`, build, ownProjectHref(d.project_id));')).toBe(0);
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst h = resolveScopedEntityHref(s, `/gates/${id}`, build, (x) => withProjectParam(x, pid));')).toBe(0);
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst ownProjectHref = (pid) => (pid ? (h) => withProjectParam(h, pid) : flatHref);\nconst h = resolveScopedEntityHref(s, id ? `/docs?id=${id}` : null, build, ownProjectHref(pid));')).toBe(0);
    // 좁히기(까디르 검수 대비) — 이름만 같은 가짜 헬퍼 · 항등을 돌려주는 팩토리 · 선언 없는 팩토리 · 조건식 한쪽이 항등.
    expect(count('function resolveScopedEntityHref(a, b, c, d) { return b; }\nconst h = resolveScopedEntityHref(s, `/docs?id=${id}`, build, flatHref);'), '가져오지 않은 같은 이름').toBe(1);
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst ownProjectHref = () => (h) => h;\nconst h = resolveScopedEntityHref(s, `/docs?id=${id}`, build, ownProjectHref(p));'), '항등 팩토리').toBe(1);
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst h = resolveScopedEntityHref(s, `/docs?id=${id}`, build, ownProjectHref(p));'), '선언 없는 팩토리').toBe(1);
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst h = resolveScopedEntityHref(s, `/docs?id=${id}`, build, p ? flatHref : (h) => h);'), '조건식 한쪽 항등').toBe(1);
    expect(count('import { resolveScopedEntityHref } from \'@/lib/entity-project-url\';\nconst h = resolveScopedEntityHref(s, `/docs?id=${id}`, build, (h) => { log(flatHref(h)); return h; });'), '감싸기를 부르긴 하나 돌려주진 않음').toBe(1);
  });

  it('예외 표 — 파일·리터럴·속성이 모두 맞을 때만(같은 파일의 다른 모양은 그대로 센다)', () => {
    expect(count("const nav = [{ path: '/more' }];", 'lib/nav-config.ts')).toBe(0);
    expect(count("export function f() { return '/chats'; }", 'lib/nav-config.ts')).toBe(1);
    expect(count("const P = ['/glance', '/inbox', '/chats', '/more'];", 'app/dashboard/dashboard-shell.tsx')).toBe(0);
    expect(count("router.push('/settings');", 'app/dashboard/dashboard-shell.tsx')).toBe(1);
    expect(count("window.location.assign('/inbox');", 'hooks/use-account-switcher.ts')).toBe(0);
    for (const e of EXEMPT) expect(e.reason.length, e.file).toBeGreaterThan(10);
  });

  it('⭐까디르 QA 4679 ① — 감싸기 함수는 이름이 아니라 선언 출처로: 파일 안 가짜 · 가져오지 않은 같은 이름은 감싼 게 아니다', () => {
    expect(countRaw("const flatHref = (h) => h;\nconst a = <Link href={flatHref('/inbox')} />;"), '로컬 가짜 flatHref').toBe(1);
    expect(countRaw("function withProjectParam(h) { return h; }\nconst a = withProjectParam('/inbox', p);"), '로컬 가짜 withProjectParam').toBe(1);
    expect(countRaw("import { withProjectParam } from '@/lib/not-the-real-one';\nconst a = withProjectParam('/inbox', p);"), '다른 모듈의 같은 이름').toBe(1);
    expect(countRaw("function f(flatHref) { return flatHref('/inbox'); }"), '믿지 않는 이름의 매개변수').toBe(1);
    // 음성 — 진짜 출처는 이름을 바꿔도 · 재수출로 가져와도 · ref로 옮겨도 감싼 것.
    expect(countRaw("import { withProjectParam as wp } from '@/lib/with-project-param';\nconst a = wp('/inbox', p);"), '이름 바꿔 가져옴').toBe(0);
    expect(countRaw("import { withProjectParam } from '@/hooks/use-flat-href';\nconst a = withProjectParam('/inbox', p);"), '재수출').toBe(0);
    expect(countRaw("import { useFlatHref } from '@/hooks/use-flat-href';\nconst go = useFlatHref();\nconst a = <Link href={go('/inbox')} />;"), '다른 이름의 flatHref').toBe(0);
    expect(countRaw("import { useFlatHref } from '@/hooks/use-flat-href';\nfunction P() { const flatHref = useFlatHref(); const r = useRef(flatHref); const f = r.current; return f('/inbox'); }"), 'ref.current').toBe(0);
    expect(countRaw("function helper(withProject) { return withProject('/inbox'); }"), '계약 매개변수 withProject').toBe(0);
  });

  it('⭐까디르 QA 4679 ② — 팩토리는 호출 자리에서 보이는 선언으로(가려진 안쪽 mk가 이긴다)', () => {
    const head = "import { resolveScopedEntityHref } from '@/lib/entity-project-url';\n";
    expect(count(head + "const mk = () => flatHref;\nfunction f() { const mk = () => (h) => h; return resolveScopedEntityHref(s, `/docs?id=${id}`, build, mk()); }"), '가려진 항등 팩토리').toBe(1);
    expect(count(head + "const mk = () => (h) => h;\nfunction f() { const mk = () => flatHref; return resolveScopedEntityHref(s, `/docs?id=${id}`, build, mk()); }"), '가려진 쪽이 진짜 — 음성').toBe(0);
  });

  it('⭐까디르 QA 4679 ③ — 감싸는 헬퍼는 호출 자리에서 import를 가리킬 때만(같은 파일 안 중첩 로컬 같은 이름은 아니다)', () => {
    const head = "import { resolveScopedEntityHref } from '@/lib/entity-project-url';\n";
    expect(count(head + "function g() { const resolveScopedEntityHref = (a, b, c, d) => b; return resolveScopedEntityHref(s, `/docs?id=${id}`, build, flatHref); }"), '중첩 로컬').toBe(1);
    expect(count(head + "function g() { return resolveScopedEntityHref(s, `/docs?id=${id}`, build, flatHref); }"), '진짜 import — 음성').toBe(0);
  });

  it(`⭐bare flat 목적지 수 = 기준값 ${BASELINE}(늘면 RED · 줄였으면 BASELINE도 낮출 것)`, () => {
    const { total, byFile } = countBareFlatLinks();
    expect(
      total,
      `bare flat 목적지 ${total}개(기준 ${BASELINE}). 늘었으면 새 목적지를 useFlatHref()로 감쌀 것 · 줄었으면 BASELINE을 ${total}로 낮출 것.\n`
        + JSON.stringify(byFile, null, 1),
    ).toBe(BASELINE);
  }, 120_000); // 저장소 전수 · 식별자마다 스코프 해석 — 부하 때 5초 기본 제한을 넘었다(실측 ~7초).
});
