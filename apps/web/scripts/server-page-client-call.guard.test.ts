// story 4714 (wheel 2 · 10-19) — a server page must not CALL a function it imports from a `'use client'` module.
//
// 왜: Next가 서버 컴포넌트에 넘기는 클라이언트 모듈의 export는 «클라이언트 참조»다 — 컴포넌트로 그리는 것(<Name />)은 되지만 함수로 부르면
// 렌더가 던져 페이지가 500이 된다. `/phone-start`가 `onboarding-form.tsx`의 `resolveOnboardingLandingHref`를 불러 dev에서 500이었다 — 페이지 함수를 직접
// 부르는 단위 시험은 서버 · 클라이언트 경계를 지나지 않고, `next build`는 force-dynamic 페이지를 그리지 않아 둘 다 통과했다.
//
// 규칙: `src/app` 아래 `'use client'`가 없는 page · layout · template · default · not-found · loading 파일이, `'use client'` 모듈에서 가져온 이름을
// 호출(`name(…)`)하면 RED. 컴포넌트로 그리는 것 · 타입 import는 괜찮다. 고치는 법: 순수 함수는 `'use client'`가 없는 lib로 옮길 것.
// 한계(정직하게): 정적 검사라 직접 호출 · 재수출(export from · import 뒤 export · 이름 바꿔 · default)만 본다. 변수에 담아 부르기(`const g = f; g()`) · 서버 모듈이 감싼 함수 안에서
// 부르기 · `export const alias = f`는 못 본다 — 그 몫은 실제 서버 렌더 확인(배포 뒤 해당 주소가 200인지)이다.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');
const SERVER_ENTRY = /^(page|layout|template|default|not-found|loading)\.tsx?$/;
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function hasUseClient(source: string): boolean {
  const file = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  for (const st of file.statements) {
    if (ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) { if (st.expression.text === 'use client') return true; continue; }
    break; // directives come first
  }
  return false;
}

/** the names the file imports (as values) from modules `isClient` says are client modules, that it then CALLS */
export function clientCalls(source: string, isClient: (specifier: string) => boolean): string[] {
  const file = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set<string>();
  for (const st of file.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !isClient(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) if (!el.isTypeOnly) names.add(el.name.text);
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
  }
  const called = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && names.has(callee.text)) called.add(callee.text);
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && names.has(callee.expression.text)) called.add(callee.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...called].sort();
}

function resolveModule(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? path.join(SRC, specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null;
  if (!base) return null;
  for (const ext of ['', ...EXTENSIONS]) {
    const candidate = base + ext;
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

/** a module is a client module when it says `'use client'` — or when it passes a client module's value on: `export … from` it, or a value it imported from one that it exports again (`export { a }` · `export default a`) — a barrel in front of a client file is still a client reference on the server */
function isClientModule(file: string, known = new Map<string, boolean>()): boolean {
  const cached = known.get(file);
  if (cached !== undefined) return cached; // a module asked twice answers the same (a cycle in progress counts as «not yet»)
  known.set(file, false);
  const answer = classify(file, known);
  known.set(file, answer);
  return answer;
}

function classify(file: string, known: Map<string, boolean>): boolean {
  const source = readFileSync(file, 'utf8');
  if (hasUseClient(source)) return true;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const fromClient = (specifier: string) => { const target = resolveModule(file, specifier); return target !== null && isClientModule(target, known); };
  const imported = new Set<string>(); // local names of values imported from a client module
  for (const st of parsed.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.importClause?.isTypeOnly || !fromClient(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) imported.add(clause.name.text);
    const b = clause.namedBindings;
    if (b && ts.isNamedImports(b)) for (const el of b.elements) if (!el.isTypeOnly) imported.add(el.name.text);
    if (b && ts.isNamespaceImport(b)) imported.add(b.name.text);
  }
  return parsed.statements.some((st) => {
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) return false;
      if (st.moduleSpecifier) return ts.isStringLiteral(st.moduleSpecifier) && fromClient(st.moduleSpecifier.text);
      const named = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : [];
      return named.some((el) => !el.isTypeOnly && imported.has((el.propertyName ?? el.name).text));
    }
    return ts.isExportAssignment(st) && ts.isIdentifier(st.expression) && imported.has(st.expression.text);
  });
}

function serverEntries(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) serverEntries(full, out);
    else if (SERVER_ENTRY.test(entry.name)) out.push(full);
  }
  return out;
}

describe('[4714] a server page never calls a function imported from a client module', () => {
  it('finds the call (the /phone-start shape), and lets components · types · server-side imports through', () => {
    const client = (s: string) => s === '@/app/onboarding/onboarding-form' || s === './widget';
    const bad = `import { resolveHref } from '@/app/onboarding/onboarding-form';\nexport default function P() { return <a href={resolveHref(true, '/a', '/b')} />; }`;
    expect(clientCalls(bad, client)).toEqual(['resolveHref']);
    const ns = `import * as W from './widget';\nexport default function P() { return <a href={W.make()} />; }`;
    expect(clientCalls(ns, client)).toEqual(['W']);
    const fine = `import { Widget } from './widget';\nimport type { Props } from './widget';\nimport { pure } from '@/lib/pure';\nexport default function P() { return <Widget href={pure(1)} />; }`;
    expect(clientCalls(fine, client)).toEqual([]);
  });

  it('a barrel that re-exports a client module is a client module too (and a barrel of plain modules is not)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-4714-'));
    try {
      writeFileSync(path.join(dir, 'client.ts'), `'use client';\nexport const resolveHref = () => '/';\n`);
      writeFileSync(path.join(dir, 'plain.ts'), `export const pure = () => '/';\n`);
      writeFileSync(path.join(dir, 'barrel.ts'), `export { resolveHref } from './client';\n`);
      writeFileSync(path.join(dir, 'outer.ts'), `export * from './barrel';\n`);
      writeFileSync(path.join(dir, 'plain-barrel.ts'), `export { pure } from './plain';\n`);
      writeFileSync(path.join(dir, 'local.ts'), `import { resolveHref } from './client';\nexport { resolveHref };\n`);
      writeFileSync(path.join(dir, 'renamed.ts'), `import { resolveHref as go } from './client';\nexport { go as href };\n`);
      writeFileSync(path.join(dir, 'dflt.ts'), `import { resolveHref } from './client';\nexport default resolveHref;\n`);
      writeFileSync(path.join(dir, 'uses-only.ts'), `import { resolveHref } from './client';\nexport const mine = () => resolveHref();\n`);
      writeFileSync(path.join(dir, 'both.ts'), `import { resolveHref } from './client';\nexport { resolveHref } from './client';\n`);
      writeFileSync(path.join(dir, 'loop-a.ts'), `export * from './loop-b';\n`);
      writeFileSync(path.join(dir, 'loop-b.ts'), `export * from './loop-a';\n`);
      expect(isClientModule(path.join(dir, 'client.ts'))).toBe(true);
      expect(isClientModule(path.join(dir, 'barrel.ts'))).toBe(true);
      expect(isClientModule(path.join(dir, 'outer.ts'))).toBe(true);
      expect(isClientModule(path.join(dir, 'local.ts'))).toBe(true); // import { a }; export { a }
      expect(isClientModule(path.join(dir, 'renamed.ts'))).toBe(true);
      expect(isClientModule(path.join(dir, 'dflt.ts'))).toBe(true);
      expect(isClientModule(path.join(dir, 'uses-only.ts'))).toBe(false); // uses it inside its own function: the server module's own function, not the client reference
      expect(isClientModule(path.join(dir, 'both.ts'))).toBe(true); // the same client file reached by an import and by a re-export
      expect(isClientModule(path.join(dir, 'plain-barrel.ts'))).toBe(false);
      expect(isClientModule(path.join(dir, 'loop-a.ts'))).toBe(false); // a cycle ends, it does not hang
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('no page · layout under src/app does', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of serverEntries(path.join(SRC, 'app'))) {
      const source = readFileSync(file, 'utf8');
      if (hasUseClient(source)) continue;
      checked += 1;
      const calls = clientCalls(source, (specifier) => {
        const target = resolveModule(file, specifier);
        return target !== null && isClientModule(target);
      });
      if (calls.length) offenders.push(`${path.relative(SRC, file)}: ${calls.join(', ')}`);
    }
    expect(checked).toBeGreaterThan(20); // the scan really reads the pages
    expect(offenders).toEqual([]);
  });
});
