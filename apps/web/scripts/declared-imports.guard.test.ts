// story #4334 — 워크스페이스 패키지가 **자기 package.json에 선언하지 않은** 패키지를 bare import하면 RED.
//
// 왜: 루트 `.npmrc`의 `shamefully-hoist=true`가 로컬 · CI 설치에서 모든 패키지를 루트 node_modules로 끌어올려, 선언이 빠져도 import가
// 풀렸다. 배포 이미지(apps/web/Dockerfile)는 .npmrc를 복사하지 않고 `pnpm install --filter web...`(엄격 배치)라 **선언한 것만** 풀린다 —
// 배포 31이 여기서 깨졌다. `next build`는 tsconfig include(`**/*.ts` — 테스트 파일 포함)를 타입 검사하므로 테스트 파일의 import도 빌드를 깨뜨린다.
//
// 규칙: 워크스페이스 패키지(pnpm-workspace.yaml)마다, 그 패키지 안 소스 파일(ts · tsx · mts · cts · js · mjs · cjs)의 bare import 이름이
// 자기 package.json의 dependencies · devDependencies · peerDependencies · optionalDependencies(또는 `@types/…`) 중에 있어야 한다.
// 세는 모양: `import … from` · `import type` · `export … from` · `import()` · `require()` · `import('x').T` 타입. 세지 않는 것: 상대 경로 ·
// 절대 경로 · Node 내장(`node:` 포함) · 앱 별칭 `@/…` · 자기 자신.
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.git']);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const BUILTIN = new Set(builtinModules);

/**
 * 예외(이유와 함께 · 늘리지 않는 것이 원칙). 표의 항목이 실제로 걸리지 않으면(고쳐졌으면) RED — 지울 것.
 * `@sprintable/storage-supabase`는 저장소 어디에도 없는 패키지(package.json · lock 0)이고, `@moonklabs/storage-saas`는 어디서도 import되지
 * 않는 죽은 EE 패키지다(루트 Dockerfile이 package.json만 복사) — 선언으로 고칠 수 없다. 정리(삭제 또는 되살림)는 별건(story #4334 PO 보고).
 */
const EXCEPTIONS: ReadonlyArray<{ pkg: string; name: string; reason: string }> = [
  { pkg: 'ee/packages/storage-saas', name: '@sprintable/storage-supabase', reason: '존재하지 않는 패키지를 import하는 죽은 EE 코드 — 정리는 별건' },
];

function workspacePackages(root: string): string[] {
  const yaml = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...yaml.matchAll(/^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1]);
  const out: string[] = [];
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const base = path.join(root, g.slice(0, -2));
      try {
        for (const d of readdirSync(base)) if (statSync(path.join(base, d)).isDirectory()) out.push(path.posix.join(g.slice(0, -2), d));
      } catch { /* 없는 글롭 기준 폴더 */ }
    } else out.push(g);
  }
  return out.filter((p) => { try { return statSync(path.join(root, p, 'package.json')).isFile(); } catch { return false; } });
}

/** 심볼릭 링크는 따라가지 않는다 — 저장소 밖이거나 같은 파일의 다른 경로(git의 supabase/migrations 링크는 CI 체크아웃에 대상이 없다 · 4701). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 하위 워크스페이스 패키지는 따로 센다(예: 중첩 package.json).
      try { if (statSync(path.join(full, 'package.json')).isFile()) continue; } catch { /* 없음 */ }
      sourceFiles(full, out);
    } else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

export function bareSpecifiers(fileName: string, text: string): string[] {
  const kind = /x$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const specs: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteral(n.arguments[0])
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) specs.push(n.arguments[0].text);
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) specs.push(n.argument.literal.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return specs.filter((s) => !(s.startsWith('.') || s.startsWith('/') || s.startsWith('@/') || s.startsWith('node:') || BUILTIN.has(s) || BUILTIN.has(s.split('/')[0])));
}

export function packageName(spec: string): string {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

export interface Undeclared { pkg: string; name: string; files: string[] }

export function findUndeclaredImports(root: string): { undeclared: Undeclared[]; packages: number; files: number } {
  const undeclared: Undeclared[] = [];
  let fileCount = 0;
  const pkgs = workspacePackages(root);
  for (const pkg of pkgs) {
    const pj = JSON.parse(readFileSync(path.join(root, pkg, 'package.json'), 'utf8'));
    const declared = new Set<string>([pj.name, ...Object.keys({ ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies, ...pj.optionalDependencies })]);
    const byName = new Map<string, Set<string>>();
    for (const file of sourceFiles(path.join(root, pkg))) {
      fileCount += 1;
      for (const spec of bareSpecifiers(file, readFileSync(file, 'utf8'))) {
        const name = packageName(spec);
        const typesName = `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;
        if (declared.has(name) || declared.has(typesName)) continue;
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name)!.add(path.relative(root, file).split(path.sep).join('/'));
      }
    }
    for (const [name, files] of byName) undeclared.push({ pkg, name, files: [...files].sort() });
  }
  return { undeclared, packages: pkgs.length, files: fileCount };
}

function withFixture(files: Record<string, string>, run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'declared-imports-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('선언 안 된 직접 import 0(story #4334 · 배포 31 부류)', () => {
  const WS = { 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n", 'apps/a/package.json': JSON.stringify({ name: 'a', dependencies: { zod: '1' }, devDependencies: { '@types/lodash': '1' } }) };

  it('⭐양성 — 선언 안 된 이름: 일반 · 타입 전용 · 재수출 · import() · require() · 타입 import() · 스코프 패키지 하위 경로 · 테스트 파일', () => {
    withFixture({
      ...WS,
      'apps/a/src/x.ts': "import { a } from 'left-pad';\nimport type { B } from 'type-only-pkg';\nexport * from 'reexported';\nconst c = await import('dyn');\nconst d = require('req');\ntype E = import('typeimp').T;\nimport f from '@scope/pkg/sub/path';\n",
      'apps/a/src/y.test.ts': "import { g } from '@tiptap/extension-document';\n",
    }, (root) => {
      const names = findUndeclaredImports(root).undeclared.map((u) => u.name).sort();
      expect(names).toEqual(['@scope/pkg', '@tiptap/extension-document', 'dyn', 'left-pad', 'reexported', 'req', 'type-only-pkg', 'typeimp']);
    });
  });

  it('음성 — 선언된 이름 · @types 짝 · 상대 · Node 내장 · node: · 앱 별칭 @/ · 자기 자신', () => {
    withFixture({
      ...WS,
      'apps/a/src/x.ts': "import { z } from 'zod';\nimport _ from 'lodash';\nimport { y } from './y';\nimport fs from 'fs';\nimport p from 'node:path';\nimport q from 'fs/promises';\nimport { h } from '@/lib/h';\nimport self from 'a/sub';\n",
    }, (root) => {
      expect(findUndeclaredImports(root).undeclared).toEqual([]);
    });
  });

  it('⭐실 저장소 — 워크스페이스 전 패키지 선언 누락 0(예외 표만)', () => {
    const { undeclared, packages, files } = findUndeclaredImports(REPO_ROOT);
    expect(packages, '워크스페이스 패키지를 실제로 모았다').toBeGreaterThanOrEqual(8);
    expect(files, '소스 파일을 실제로 모았다').toBeGreaterThan(1000);
    const isException = (u: Undeclared) => EXCEPTIONS.some((e) => e.pkg === u.pkg && e.name === u.name);
    const unexpected = undeclared.filter((u) => !isException(u));
    expect(unexpected, unexpected.map((u) => `${u.pkg}: ${u.name} ← ${u.files.slice(0, 3).join(', ')}`).join('\n')).toEqual([]);
    for (const e of EXCEPTIONS) {
      expect(undeclared.some((u) => u.pkg === e.pkg && u.name === e.name), `예외가 더는 안 걸린다(고쳐졌으면 표에서 지울 것): ${e.pkg} ${e.name}`).toBe(true);
    }
  }, 120_000);
});
