// story #4226(PO 판단 23:19Z · 까디르 QA cd595a263) — `?p=` 없이 flat 목적지로 가는 앱 내부 이동의 래칫.
// flat 목적지 = `app/(authenticated)` 아래 `[` 로 시작하지 않는 최상위 폴더(새 flat 라우트가 생기면 자동 포함).
// 셈법은 정규식이 아니라 **TypeScript 컴파일러 AST**.
// story #4231 3차(PO 02:02Z) — 예전 셈법은 «이동 자리 모양»(JSX href · router.push/replace · `href:`/`path:`)만 봐서, href 헬퍼의 `return` ·
//   `window.location.href/assign` · 다른 이름 prop(`targetRoute`·`conversationHref`·`secondaryHref`) · 상수로 만든 목적지를 못 셌다(≈30곳).
//   이제는 **flat 리터럴이 어디에 있든 센다**(템플릿은 머리 글자 · 조건식은 갈래마다). 세지 않는 것은 셋뿐이다:
//   ① 감싼 자리 — `flatHref(…)`·`withProjectParam(…)`·`withProject(…)`·`useConnectRulesHref(…)` 호출 안(아래 WRAPPERS).
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
// 프로젝트를 싣는 함수 — flatHref(useFlatHref) · withProjectParam(lib) · withProject(헬퍼가 **필수 인자**로 받는 «프로젝트를 싣는 함수» —
// 프로젝트 단위 소비처는 useFlatHref를, 조직 전체 목록은 «항목 자신의 프로젝트를 싣는 함수»를 넘긴다 · #4231 3차 PO 02:34Z) ·
// useConnectRulesHref(결과에 현재 프로젝트를 싣는 훅) · projectHref(#4231 4차 — slug를 알면 scoped 경로 · 모르면 항목 project_id를 `?p=`로).
const WRAPPERS = new Set(['flatHref', 'withProjectParam', 'withProject', 'useConnectRulesHref', 'projectHref']);
// 이동이 아닌 호출의 인자(구조 판정) — 탭 정체성(useSyntheticParentTabHistory: 어느 탭 소속인지 표시 · 이동 아님) · 정적 파일 fetch.
const NON_NAV_CALLEES = new Set(['useSyntheticParentTabHistory', 'fetch']);
const PREDICATE_METHODS = new Set(['startsWith', 'endsWith', 'includes', 'indexOf', 'match', 'test']);
// story #4231 다음 조각(래칫 맹점 ③ · 까디르 4614 codex P2) — 옛 자원 · flat 경로를 **조립하는 헬퍼**. 리터럴이 헬퍼 안(`/${resource}`)에
// 있어 머리 글자로는 못 셌다. 이 헬퍼 호출 = flat 목적지로 센다 — 인자에 프로젝트를 싣는 함수(WRAPPERS)가 있을 때만 세지 않는다.
const ASSEMBLERS = new Set(['scopedResourceHref', 'destHref', 'resolveTabHref']);
// story #4231 마지막 조각 — 폴백 경로를 **받아서 감싸는** 헬퍼(계약상 감싸는 함수가 필수 인자). 리터럴은 호출 자리에선 bare로 보이지만
// 헬퍼가 그 함수로 감싸 내보낸다(`resolveScopedEntityHref(slugs, '/board?story=…', build, withProject)` — #4253 «폴백은 bare로 못 나간다» ·
// entity-project-url.test.ts가 감쌈을 고정). 감싸는 인자가 실제로 프로젝트를 싣는 함수일 때만 그 폴백 리터럴을 세지 않는다.
const WRAPPING_HELPERS: ReadonlyMap<string, { fallbackArg: number; wrapperArg: number }> = new Map([
  ['resolveScopedEntityHref', { fallbackArg: 1, wrapperArg: 3 }],
]);
// 프로젝트를 싣는 함수를 **돌려주는** 팩토리(embed-card: 항목 project_id가 있으면 그 p · 없으면 flatHref).
const WRAPPER_FACTORIES = new Set(['ownProjectHref']);

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

/** 리터럴이 해시(#) 앞 쿼리에 `p` 키를 스스로 싣는지(템플릿은 머리 + 각 조각 꼬리 · 치환 자리는 \u0000). 키 판정은 withProjectParam과 같은 뜻. */
/** 인자가 «프로젝트를 싣는 함수»인가 — WRAPPERS 이름 · 팩토리 호출 · 본문에서 WRAPPERS를 부르는 화살표. 항등 `(h) => h`는 아니다. */
function isProjectCarryingFn(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  if (ts.isIdentifier(arg)) return WRAPPERS.has(arg.text);
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) return WRAPPER_FACTORIES.has(arg.expression.text);
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    let found = false;
    const visit = (n: ts.Node) => { if (isWrapperCall(n)) found = true; else ts.forEachChild(n, visit); };
    visit(arg.body);
    return found;
  }
  return false;
}

/** 리터럴이 감싸는 헬퍼의 폴백 인자 자리이고, 그 호출이 프로젝트를 싣는 함수를 넘기는가. */
function isWrappedFallback(node: ts.Node): boolean {
  const { child, parent } = effectiveParent(node);
  if (!parent || !ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression)) return false;
  const spec = WRAPPING_HELPERS.get(parent.expression.text);
  if (!spec || parent.arguments[spec.fallbackArg] !== child) return false;
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
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && WRAPPERS.has(node.expression.text);
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
      const wrapped = node.arguments.some((a) => ts.isIdentifier(a) && WRAPPERS.has(a.text));
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
  const count = (src: string, rel = 'x.tsx') => countBareFlatLinksInSource('x.tsx', src, routes, rel);

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
    expect(count('const h = resolveTabHref(tab, dest, scope, withProject);')).toBe(0);
    expect(count("const TABS = [{ href: destHref(D.work, {}, keepHref) }];", 'components/nav/mobile-tab-bar.tsx')).toBe(0);
    expect(count("const x = destHref(D.work, {}, keepHref);", 'components/nav/mobile-tab-bar.tsx')).toBe(1);
  });

  it('⭐#4296 맹점 ④ — 데이터에서 오는 경로 템플릿(`/${item.path}` · `/${resource}`)도 flat 목적지로 센다', () => {
    // 양성: «전체» 메뉴가 자원 항목을 bare로 내보내던 바로 그 줄 모양 · 이름이 path/resource로 끝나는 치환.
    expect(count("const href = item.kind === 'static' ? flatHref(item.path) : `/${item.path}`;")).toBe(1);
    expect(count('const h = `/${resource}`;')).toBe(1);
    expect(count('router.push(`/${dest.resourcePath}?tab=x`);')).toBe(1);
    // 음성: 감싼 자리 · 스스로 p를 싣는 자리 · scoped 조립(첫 치환이 조직 · 프로젝트) · path가 아닌 치환 · 비교.
    expect(count('const h = withProject(`/${resource}`);')).toBe(0);
    expect(count('const h = `/${item.path}?p=${pid}`;')).toBe(0);
    expect(count('const h = `/${orgSlug}/${projectSlug}/${resource}`;')).toBe(0);
    expect(count('const h = `/${slug}`;')).toBe(0);
    expect(count('const h = `/${item.pathname}`;')).toBe(0);
    expect(count('if (href === `/${item.path}`) {}')).toBe(0);
  });

  it('⭐#4231 마지막 조각 — 감싸는 헬퍼의 폴백 리터럴은 감싸는 인자가 프로젝트를 싣는 함수일 때만 세지 않는다', () => {
    // 양성 — 감싸는 인자가 없거나 · 항등 · 모르는 이름이면 bare 폴백으로 센다.
    expect(count('const h = resolveScopedEntityHref(s, `/docs?id=${id}`, build);')).toBe(1);
    expect(count('const h = resolveScopedEntityHref(s, `/docs?id=${id}`, build, (h) => h);')).toBe(1);
    expect(count('const h = resolveScopedEntityHref(s, `/gates/${id}`, build, keep);')).toBe(1);
    // 폴백 자리가 아닌 인자에 둔 flat 리터럴은 그대로 센다.
    expect(count('const h = resolveScopedEntityHref(s, null, () => `/docs?id=${id}`, flatHref);')).toBe(1);
    // 음성 — 프로젝트를 싣는 함수(이름 · 팩토리 · 그 함수를 부르는 화살표) · 조건식 폴백 갈래.
    expect(count('const h = resolveScopedEntityHref(s, `/docs?id=${id}`, build, flatHref);')).toBe(0);
    expect(count('const h = resolveScopedEntityHref(s, `/gates/${id}`, build, ownProjectHref(d.project_id));')).toBe(0);
    expect(count('const h = resolveScopedEntityHref(s, `/gates/${id}`, build, (x) => withProjectParam(x, pid));')).toBe(0);
    expect(count('const h = resolveScopedEntityHref(s, id ? `/docs?id=${id}` : null, build, ownProjectHref(pid));')).toBe(0);
  });

  it('예외 표 — 파일·리터럴·속성이 모두 맞을 때만(같은 파일의 다른 모양은 그대로 센다)', () => {
    expect(count("const nav = [{ path: '/more' }];", 'lib/nav-config.ts')).toBe(0);
    expect(count("export function f() { return '/chats'; }", 'lib/nav-config.ts')).toBe(1);
    expect(count("const P = ['/glance', '/inbox', '/chats', '/more'];", 'app/dashboard/dashboard-shell.tsx')).toBe(0);
    expect(count("router.push('/settings');", 'app/dashboard/dashboard-shell.tsx')).toBe(1);
    expect(count("window.location.assign('/inbox');", 'hooks/use-account-switcher.ts')).toBe(0);
    for (const e of EXEMPT) expect(e.reason.length, e.file).toBeGreaterThan(10);
  });

  it(`⭐bare flat 목적지 수 = 기준값 ${BASELINE}(늘면 RED · 줄였으면 BASELINE도 낮출 것)`, () => {
    const { total, byFile } = countBareFlatLinks();
    expect(
      total,
      `bare flat 목적지 ${total}개(기준 ${BASELINE}). 늘었으면 새 목적지를 useFlatHref()로 감쌀 것 · 줄었으면 BASELINE을 ${total}로 낮출 것.\n`
        + JSON.stringify(byFile, null, 1),
    ).toBe(BASELINE);
  });
});
