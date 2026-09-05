// story #3519(§16-7 2부 "나란히 부르되 같은 급으로 묶지 않는다", PO 確定 2026-09-05) —
// `Promise.all`에 `fetchWithAuth` 호출을 2개 이상 묶은 자리 전수를 AST(TypeScript
// 컴파일러 API)로 찾아, 그 자리에 격리 메커니즘(leg별 `.catch`, 전체 체인
// `.catch`/`.then(ok,err)`, 감싸는 `try{...}catch{...}`, 또는 `Promise.allSettled`
// 사용)이 «단 하나도» 없는 경우만 RED로 잡는다.
//
// ⚠️이 가드가 못 잡는 것(선언) — catch가 «있기는 한데» 부수(secondary) leg를 주
// (primary)로 잘못 승격시키는 오분류(예: catch가 leg 하나에만 있고 나머지 부수
// leg는 안 걸린 채로 방치되는 경우, 또는 catch는 있는데 그 catch 자체가 원래
// «부수»였어야 할 데이터를 «전체 로드 실패»로 승격시켜 버리는 경우)는 이 가드의
// 기계적 검사(catch 유무)로는 구분이 안 된다 — 표기 존재만 검사하지 «맞다»는
// 검사 못 한다. 이 스토리 자체가 그 오분류 클래스의 실사례 4곳을 손으로 찾아
// 고쳤다(standup-client.tsx:249, channel-posts/[draftId]/page.tsx:703,
// agent-management-tab.tsx:115, my-notification-channel-section.tsx:93 — 전부
// catch가 «있었지만» 격리 범위가 틀렸던 자리들). 이런 자리의 재발 방지는 이
// 가드가 아니라 개별 리뷰(§16-7 2부 판정선: !res.ok→setLoadError/return=주,
// res.ok?채움:degrade=부수)의 몫이다.
//
// 양성대조(가드가 실제로 «실패할 수 있다»는 증거) — 이 스토리에서 고친 approvals-
// queue.tsx:47(수정 前 스냅샷: 두 leg 다 `.then(...)`뿐, catch가 파일 어디에도
// 없어 이 가드가 실제로 RED였다)를 아래 테스트로 재현해 고정한다. 3514 이전
// content/[draftId]/page.tsx는 양성대조로 안 쓴다 — 그 버전도 이미 `.catch`가
// 있어(격리 «범위»가 틀렸을 뿐 catch 자체는 있었다) 이 가드의 검사 대상 밖이다
// (위 "못 잡는 것" 문단과 동일 사유).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const SRC_ROOT = join(__dirname, '../');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  legCount: number;
  hasAnyCatch: boolean;
}

/** node 체인(예: `fetchWithAuth(...).then(...).catch(...)`)에서 fetchWithAuth 호출을
 * 포함하는지, 그리고 그 체인 어딘가에 .catch(...)가 있는지를 판정한다. */
function analyzeLegExpression(expr: ts.Expression): { isFetchLeg: boolean; hasCatch: boolean } {
  let isFetchLeg = false;
  let hasCatch = false;
  function walk(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'fetchWithAuth') isFetchLeg = true;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'catch') hasCatch = true;
    }
    node.forEachChild(walk);
  }
  walk(expr);
  return { isFetchLeg, hasCatch };
}

/** Promise.all(...) 호출 노드에서 위로 올라가며 (a) 전체 체인에 걸린 .then(...).catch나
 * .catch가 있는지, (b) try{...}catch{...}로 감싸여 있는지를 판정한다. await 표현식·
 * 변수 대입 등 중간 노드는 건너뛴다. */
function hasWholeChainIsolation(promiseAllCall: ts.CallExpression): boolean {
  let node: ts.Node = promiseAllCall;
  // 위로 타고 올라가며 .then/.catch 체인 확인 (Promise.all(...).then(...).catch(...) 형태)
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isPropertyAccessExpression(current) && current.name.text === 'catch') return true;
    if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current) || ts.isAwaitExpression(current)) {
      current = current.parent;
      continue;
    }
    break;
  }
  // try { ...await Promise.all(...)... } catch { ... } 형태
  node = promiseAllCall;
  while (node.parent) {
    node = node.parent;
    if (ts.isTryStatement(node) && node.catchClause) {
      // node.tryBlock이 promiseAllCall을 실제로 포함하는지(catchBlock 자체 안에서
      // 시작된 게 아닌지) — SourceFile 위치 비교로 판정.
      const start = node.tryBlock.getStart();
      const end = node.tryBlock.getEnd();
      const target = promiseAllCall.getStart();
      if (target >= start && target <= end) return true;
    }
    if (ts.isSourceFile(node)) break;
  }
  return false;
}

function scanFile(filePath: string, content: string): Site[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: Site[] = [];

  function resolveArrayElements(arg: ts.Expression): ts.Expression[] | null {
    if (ts.isArrayLiteralExpression(arg)) return [...arg.elements];
    if (ts.isIdentifier(arg)) {
      // 같은 파일 안에서 `const arr = [...]` 형태로 선언된 변수만 추적한다(단일 파일
      // 스코프 — cross-file 추적은 이 가드 범위 밖).
      const targetName = arg.text;
      let found: ts.Expression[] | null = null;
      function findDecl(n: ts.Node) {
        if (found) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === targetName && n.initializer && ts.isArrayLiteralExpression(n.initializer)) {
          found = [...n.initializer.elements];
        }
        n.forEachChild(findDecl);
      }
      findDecl(sourceFile);
      return found;
    }
    return null;
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression) && callee.expression.text === 'Promise'
        && callee.name.text === 'all'
        && node.arguments.length === 1
      ) {
        const elements = resolveArrayElements(node.arguments[0]!);
        if (elements) {
          let legCount = 0;
          let anyLegHasCatch = false;
          for (const el of elements) {
            const { isFetchLeg, hasCatch } = analyzeLegExpression(el);
            if (isFetchLeg) {
              legCount += 1;
              if (hasCatch) anyLegHasCatch = true;
            }
          }
          if (legCount >= 2) {
            const hasAnyCatch = anyLegHasCatch || hasWholeChainIsolation(node);
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            sites.push({ file: filePath, line: line + 1, legCount, hasAnyCatch });
          }
        }
      }
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return sites;
}

function scanAll(): Site[] {
  const sites: Site[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const content = readFileSync(file, 'utf-8');
    if (!content.includes('fetchWithAuth')) continue;
    if (!content.includes('Promise.all')) continue;
    sites.push(...scanFile(file, content));
  }
  return sites;
}

describe('Promise.all + fetchWithAuth 격리 가드(story #3519)', () => {
  it('스캔 대상이 비어있지 않다(가드 자체가 죽은 채 항상 통과하는 것 방지)', () => {
    expect(scanAll().length).toBeGreaterThan(0);
  });

  it('fetchWithAuth 2legs 이상인 Promise.all 자리 전부에 격리(leg별 catch/전체체인 catch/try-catch)가 최소 하나 있다', () => {
    const sites = scanAll();
    const uncaught = sites.filter((s) => !s.hasAnyCatch);
    const report = uncaught.map((s) => `${s.file.replace(SRC_ROOT, '')}:${s.line} (${s.legCount} legs)`).join('\n');
    expect(uncaught, `격리 0인 자리:\n${report}`).toEqual([]);
  });

  // 양성대조 — approvals-queue.tsx의 수정 前 실제 코드(git 이력 그대로, story #3519
  // 착수 시점 스냅샷)를 이 스캐너에 직접 통과시켜 실제로 RED가 되는지 고정한다.
  // 이 가드를 미래에 손대다 조용히 무력화되는 걸(항상 그린) 이 테스트가 잡는다.
  it('양성대조 — approvals-queue.tsx 수정 前 스냅샷(catch 0)은 이 가드가 실제로 잡는다', () => {
    const beforeFixSnippet = `
      async function fetchGates(): Promise<GateInboxItem[]> {
        const [pending, held] = await Promise.all([
          fetchWithAuth('/api/gates/inbox?status=pending&sort=urgency&assigned_to_me=true').then((r) => (r.ok ? r.json() : [])),
          fetchWithAuth('/api/gates/inbox?status=held&sort=urgency&assigned_to_me=true').then((r) => (r.ok ? r.json() : [])),
        ]);
        return [...(pending as GateInboxItem[]), ...(held as GateInboxItem[])];
      }
    `;
    const sites = scanFile('positive-control.tsx', beforeFixSnippet);
    expect(sites.length).toBe(1);
    expect(sites[0]!.hasAnyCatch).toBe(false);
  });

  it('음성대조 — 격리된 자리(leg별 catch)는 이 가드가 통과시킨다(오탐 방지)', () => {
    const isolatedSnippet = `
      async function load() {
        const [a, b] = await Promise.all([
          fetchWithAuth('/api/a').catch(() => null),
          fetchWithAuth('/api/b').catch(() => null),
        ]);
      }
    `;
    const sites = scanFile('negative-control.tsx', isolatedSnippet);
    expect(sites.length).toBe(1);
    expect(sites[0]!.hasAnyCatch).toBe(true);
  });

  it('음성대조 — try/catch로 감싼 자리도 이 가드가 통과시킨다(전체체인 격리 인정)', () => {
    const tryCatchSnippet = `
      async function load() {
        try {
          const [a, b] = await Promise.all([
            fetchWithAuth('/api/a'),
            fetchWithAuth('/api/b'),
          ]);
        } catch {
          setLoadError(true);
        }
      }
    `;
    const sites = scanFile('negative-control-trycatch.tsx', tryCatchSnippet);
    expect(sites.length).toBe(1);
    expect(sites[0]!.hasAnyCatch).toBe(true);
  });
});
