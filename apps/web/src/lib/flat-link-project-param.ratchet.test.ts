// story #4226(PO 판단 23:19Z · 까디르 QA cd595a263) — `?p=` 없이 flat 목적지로 가는 앱 내부 이동의 래칫.
// flat 목적지 = `app/(authenticated)` 아래 `[` 로 시작하지 않는 최상위 폴더(새 flat 라우트가 생기면 자동 포함).
// 셈법은 정규식이 아니라 **TypeScript 컴파일러 AST**(정규식은 조건식 href·`router.push (` 공백 같은 유효한 모양을 놓쳤다 — 4587 파서와 같은 부류):
//   대상 식 = JSX `href` 속성 값 · `router.push/replace(…)` 첫 인자 · 객체 속성 `href:`/`path:` 값.
//   그 식 안의 문자열·템플릿 리터럴 중 `/{flat}`(뒤가 `/`·`?`·끝)로 시작하는 것을 하나씩 센다(조건식이면 갈래마다).
//   `useFlatHref()`로 감싼 자리(`flatHref(…)`·`withProjectParam(…)` 호출 안)는 세지 않는다.
// 이 수가 **늘면 RED**(새 bare flat 링크 금지). 줄였으면 BASELINE도 같이 낮출 것(래칫) — 후속 카드 #4231이 0까지 내린다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const BASELINE = 93;

const SRC = path.resolve(__dirname, '..');
const AUTH = path.join(SRC, 'app/(authenticated)');
const WRAPPERS = new Set(['flatHref', 'withProjectParam']);

function flatRoutes(): string[] {
  return readdirSync(AUTH).filter((d) => !d.startsWith('[') && statSync(path.join(AUTH, d)).isDirectory()).sort();
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

function isWrapperCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && WRAPPERS.has(node.expression.text);
}

function isRouterNavCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== 'push' && callee.name.text !== 'replace') return false;
  const obj = callee.expression;
  const objName = ts.isIdentifier(obj) ? obj.text : ts.isPropertyAccessExpression(obj) ? obj.name.text : '';
  return /router/i.test(objName);
}

/** 대상 식 안의 bare flat 리터럴 수(감싼 호출 안은 건너뜀 · 조건식은 갈래마다). */
function countInTarget(expr: ts.Node, flatRe: RegExp): number {
  let n = 0;
  const visit = (node: ts.Node) => {
    if (isWrapperCall(node)) return;
    const text = literalText(node);
    if (text !== null) {
      if (flatRe.test(text)) n += 1;
      if (!ts.isTemplateExpression(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return n;
}

export function countBareFlatLinksInSource(fileName: string, text: string, routes: string[]): number {
  const flatRe = new RegExp(`^/(${routes.map((r) => r.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})(?=[/?]|$)`);
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'href' && node.initializer) {
      n += countInTarget(node.initializer, flatRe);
    } else if (ts.isCallExpression(node) && isRouterNavCall(node) && node.arguments[0]) {
      n += countInTarget(node.arguments[0], flatRe);
    } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      && (node.name.text === 'href' || node.name.text === 'path')) {
      n += countInTarget(node.initializer, flatRe);
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
    const n = countBareFlatLinksInSource(file, readFileSync(file, 'utf8'), routes);
    if (n) { byFile[path.relative(SRC, file)] = n; total += n; }
  }
  return { total, byFile };
}

describe('`?p=` 없는 flat 링크 래칫(story #4226 → #4231 · TS AST 셈법)', () => {
  const routes = ['inbox', 'chats', 'gates', 'more', 'organization'];
  const count = (src: string) => countBareFlatLinksInSource('x.tsx', src, routes);

  it('양성대조 — 네 모양 · 조건식 갈래마다 · `router.push (` 공백 · 여러 줄 인자를 센다', () => {
    expect(count('const a = <Link href="/inbox?tab=gates" />;')).toBe(1);
    expect(count('const a = <Link href={cond ? todayHref : `/gates/${id}`} />;')).toBe(1);
    expect(count('const a = <Link href={cond ? "/chats" : `/gates/${id}`} />;')).toBe(2);
    expect(count('router.push (`/chats/${id}`);')).toBe(1);
    expect(count('router.push(\n  compose ? `/chats/${c}?compose=${x}` : `/chats/${c}`,\n);')).toBe(2);
    expect(count("this.props.router.replace('/more');")).toBe(1);
    expect(count("const nav = [{ id: 'more', path: '/more' }, { href: '/organization/events' }];")).toBe(2);
  });

  it('음성대조 — 감싼 자리 · scoped 경로 · flat이 아닌 접두 · 대상 식 밖 문자열은 안 센다', () => {
    expect(count("const a = <Link href={flatHref('/inbox?tab=gates')} />;")).toBe(0);
    expect(count('const a = <Link href={flatHref(cond ? "/chats" : `/gates/${id}`)} />;')).toBe(0);
    expect(count('const a = <Link href={`/${ws}/${proj}/flow`} />;')).toBe(0);
    expect(count("const a = <Link href=\"/inboxes\" />;")).toBe(0);
    expect(count("fetch('/inbox'); const label = '/chats';")).toBe(0);
  });

  it(`⭐bare flat 링크 수 = 기준값 ${BASELINE}(늘면 RED · 줄였으면 BASELINE도 낮출 것)`, () => {
    const { total, byFile } = countBareFlatLinks();
    expect(
      total,
      `bare flat 링크 ${total}개(기준 ${BASELINE}). 늘었으면 새 링크를 useFlatHref()로 감쌀 것 · 줄었으면 BASELINE을 ${total}로 낮출 것.\n`
        + JSON.stringify(byFile, null, 1),
    ).toBe(BASELINE);
  });
});
