// story #4333(PO 판정 2026-09-26) — 테스트 시한으로 **성능 예산**을 걸지 않는다.
//
// 예전 관례(#3902): 실 트리 전수 스캔 테스트마다 «실측 최댓값×3»으로 기본(5초)보다 낮은 시한을 걸었다. 전체 판 병렬 부하에선 같은
// 코드가 그 시한을 넘겨 **까닭 없이** RED였다 — 판정이 부하에 따라 달라지니 «틀릴 수 있는 테스트»가 아니라 «아무 까닭 없이도 틀리는
// 테스트». 시한은 행(hang) 가드(기본 5초 이상)로만 쓰고, 일의 양은 결정적으로 잰다(scripts/test-utils/fs-work.ts — 한 스캔에서 같은
// 파일을 두 번 읽으면 RED).
//
// 이 가드: vitest가 도는 테스트 파일 전수(설정의 exclude와 같은 제외)에서 5초 미만 시한을 센다 — `it/test(이름, fn, 숫자)` ·
// `it/test(이름, fn, { timeout })` · `describe(이름, { timeout }, fn)` · `vi.setConfig({ testTimeout })` · 설정 객체의 `testTimeout`.
// 허용 목록은 없다(0) — 새 벽시계 예산은 결정적 양으로 바꿀 것.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
export const MIN_TIMEOUT_MS = 5000;
// vitest.config.ts exclude와 같은 축 — `**/x/**`(어느 깊이든)와 `x/**`(저장소 루트만)을 가른다. 예전엔 `connectors`를 어느 깊이에서나
// 빼서 apps/web의 connectors 라우트 테스트 3개를 놓쳤다(vitest list 대조로 적발).
const SKIP_ANY_DEPTH = new Set(['node_modules', 'dist', '.next', 'e2e', '.git', '.turbo', 'coverage']);
const SKIP_AT_ROOT = new Set(['.qa-worktrees', 'connectors']);
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/;
const TEST_CALLS = new Set(['it', 'test']);

/**
 * 저장소가 **실제로 가진** 테스트 파일 — 심볼릭 링크는 따라가지 않는다. `supabase/migrations`는 git에 심볼릭 링크(모드 120000)로 들어 있고
 * 대상(개발 머신의 절대 경로)이 CI 체크아웃에는 없다 — statSync로 따라가면 CI에서 ENOENT로 죽었다(PR 4701 CI · 로컬은 대상이 있어 통과).
 * 링크 너머는 저장소 밖이거나 같은 파일의 다른 경로라 vitest가 도는 테스트 집합과 같다(그 링크 대상엔 .sql뿐 — 테스트 0).
 */
export function testFiles(dir: string, out: string[] = [], root = dir): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_ANY_DEPTH.has(entry.name) || entry.isSymbolicLink() || (dir === root && SKIP_AT_ROOT.has(entry.name))) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out, root);
    else if (entry.isFile() && TEST_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

function numberValue(node: ts.Node | undefined): number | null {
  if (!node) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''));
  if (ts.isParenthesizedExpression(node)) return numberValue(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
    const l = numberValue(node.left); const r = numberValue(node.right);
    return l !== null && r !== null ? l * r : null;
  }
  return null;
}

function objectProp(obj: ts.Node | undefined, key: string): number | null {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key) return numberValue(p.initializer);
  }
  return null;
}

/** `it` · `test` · `describe`(+ `.only` · `.skip` · `.concurrent` 등)의 바탕 이름. */
function baseCallee(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return baseCallee(expr.expression);
  return null;
}

export function findWallclockBudgets(fileName: string, text: string): string[] {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : fileName.endsWith('js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const hits: string[] = [];
  const at = (n: ts.Node) => `${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const base = baseCallee(n.expression);
      const args = n.arguments;
      if (base && TEST_CALLS.has(base) && args.length >= 3) {
        const ms = numberValue(args[2]) ?? objectProp(args[2], 'timeout');
        if (ms !== null && ms < MIN_TIMEOUT_MS) hits.push(`${at(n)} ${base} 시한 ${ms}ms`);
      }
      if (base === 'describe' && args.length >= 2) {
        const ms = objectProp(args[1], 'timeout');
        if (ms !== null && ms < MIN_TIMEOUT_MS) hits.push(`${at(n)} describe 시한 ${ms}ms`);
      }
    }
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === 'testTimeout') {
      const ms = numberValue(n.initializer);
      if (ms !== null && ms < MIN_TIMEOUT_MS) hits.push(`${at(n)} testTimeout ${ms}ms`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe('테스트 시한으로 성능 예산을 걸지 않는다(story #4333 · #3902 관례 폐기)', () => {
  const count = (src: string) => findWallclockBudgets('x.test.ts', src).length;

  it('양성 — 5초 미만 시한(숫자 · 객체 · 곱 · describe · vi.setConfig · 설정 testTimeout · .only/.concurrent)', () => {
    expect(count("it('a', () => {}, 500);")).toBe(1);
    expect(count("test('a', () => {}, 1_000);")).toBe(1);
    expect(count("it('a', () => {}, { timeout: 2500 });")).toBe(1);
    expect(count("it('a', () => {}, 4 * 1000);")).toBe(1);
    expect(count("describe('a', { timeout: 3000 }, () => {});")).toBe(1);
    expect(count('vi.setConfig({ testTimeout: 1000 });')).toBe(1);
    expect(count("export default { test: { testTimeout: 2000 } };")).toBe(1);
    expect(count("it.only('a', () => {}, 800);")).toBe(1);
    expect(count("it.concurrent('a', async () => {}, 900);")).toBe(1);
  });

  it('음성 — 기본 시한 · 5초 이상(행 가드) · 테스트 호출이 아닌 숫자', () => {
    expect(count("it('a', () => {});")).toBe(0);
    expect(count("it('a', () => {}, 5000);")).toBe(0);
    expect(count("it('a', () => {}, 120_000);")).toBe(0);
    expect(count("it('a', () => {}, { timeout: 60_000 });")).toBe(0);
    expect(count('setTimeout(() => {}, 100);')).toBe(0);
    expect(count("expect(x).toBe(500);")).toBe(0);
  });

  it('⭐대상 없는 심볼릭 링크가 든 트리에서도 죽지 않고 돈다(CI 체크아웃 · supabase/migrations 모양)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wallclock-symlink-'));
    try {
      mkdirSync(path.join(root, 'pkg'), { recursive: true });
      writeFileSync(path.join(root, 'pkg', 'a.test.ts'), "it('a', () => {}, 500);\n");
      symlinkSync(path.join(root, '__no_such_target__'), path.join(root, 'dangling'));
      const files = testFiles(root);
      expect(files.map((f) => path.relative(root, f))).toEqual([path.join('pkg', 'a.test.ts')]);
      expect(files.flatMap((f) => findWallclockBudgets(f, readFileSync(f, 'utf8')))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('⭐실 저장소 — 5초 미만 시한 0(허용 목록 없음)', () => {
    const files = testFiles(REPO_ROOT);
    expect(files.length, '테스트 파일을 실제로 모았다(헛돌지 않게)').toBeGreaterThan(1000);
    const hits = files.flatMap((f) => findWallclockBudgets(path.relative(REPO_ROOT, f), readFileSync(f, 'utf8')));
    expect(hits, `5초 미만 시한 — 결정적 양(scripts/test-utils/fs-work.ts)으로 바꿀 것:\n${hits.join('\n')}`).toEqual([]);
  }, 120_000);
});
