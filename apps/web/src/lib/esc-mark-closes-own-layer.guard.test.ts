// [SID:4369 · 까디르 기록(PR 4749)] 부류 가드 — «Esc에 preventDefault(= 이 Esc를 썼다는 표시)를 부르는 자리는 같은 갈래에서 자기 층을 닫는다».
// 4367(PR 4749)부터 바깥 층(스토리 패널 window Esc · useFocusTrap · 작업 목록 선택 해제 · base-ui Sheet/Dialog 뿌리)이 표시된 Esc를 건너뛴다
// (lib/inner-layer-esc.ts). 그래서 자기 층을 닫지 않으면서 Esc에 표시만 하는 요소가 생기면 그 요소를 품은 창 · 시트 · 서랍 · 패널이
// Esc로 영영 안 닫힌다(갇힘).
// 방법(소스 AST · 읽기만): 조건에 'Escape'를 쓰는 if 문의 참 갈래(중첩 함수 밖)에 `.preventDefault()`가 있으면, 같은 갈래에
// «닫기» 호출(이름에 close · cancel · reset · dismiss · clear · hide · remove · exit · abort · onEscape가 든 호출 · 또는 setX(false | null))이 있어야 한다.
// 한계: 이름으로 가른다(«닫기» 낱말을 쓰는 다른 호출도 통과 — 거짓 음성 쪽). switch 문 `case 'Escape':`도 같은 판으로 본다.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '..');
const CLOSE_NAME = /close|cancel|reset|dismiss|clear|hide|remove|exit|abort|onescape/i;

type Site = { file: string; line: number; closes: boolean; text: string };

function isEscapeTest(expr: ts.Node, sf: ts.SourceFile): boolean {
  return /['"]Escape['"]/.test(expr.getText(sf));
}

function callsIn(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => {
    // 중첩 함수 안의 호출은 이 갈래의 동작이 아니다(콜백 · 나중에 도는 코드).
    if (n !== node && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))) return;
    if (ts.isCallExpression(n)) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

function calleeName(c: ts.CallExpression): string {
  const e = c.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
}

function isClose(c: ts.CallExpression, sf: ts.SourceFile): boolean {
  const name = calleeName(c);
  if (name === 'preventDefault' || name === 'stopPropagation' || name === 'stopImmediatePropagation') return false;
  if (CLOSE_NAME.test(name)) return true;
  // setOpen(false) · setX(null) — 상태로 층을 닫는 모양.
  if (/^set[A-Z]/.test(name) && c.arguments.length === 1 && /^(false|null)$/.test(c.arguments[0]!.getText(sf))) return true;
  return false;
}

export function escMarkSites(file: string, src: string): Site[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: Site[] = [];
  const judge = (branch: ts.Node, at: ts.Node): void => {
    const calls = callsIn(branch);
    if (!calls.some((c) => calleeName(c) === 'preventDefault')) return;
    sites.push({ file, line: sf.getLineAndCharacterOfPosition(at.getStart()).line + 1, closes: calls.some((c) => isClose(c, sf)), text: branch.getText(sf).replace(/\s+/g, ' ').slice(0, 120) });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n) && isEscapeTest(n.expression, sf)) judge(n.thenStatement, n);
    if (ts.isCaseClause(n) && isEscapeTest(n.expression, sf)) judge(n, n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...sourceFiles(p)); continue; }
    if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('Esc 표시(preventDefault)는 자기 층을 닫는 갈래에서만([SID:4369])', () => {
  it('양성 대조 — 표시만 하고 안 닫는 갈래는 잡고 · 닫는 갈래는 통과', () => {
    const bad = escMarkSites('bad.tsx', "function h(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); return; } }");
    expect(bad).toHaveLength(1);
    expect(bad[0]!.closes).toBe(false);
    const good = escMarkSites('good.tsx', "function h(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }");
    expect(good.map((s) => s.closes)).toEqual([true]);
    const setter = escMarkSites('set.tsx', "const f = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };");
    expect(setter.map((s) => s.closes)).toEqual([true]);
    // 중첩 콜백 안의 닫기는 이 갈래의 닫기가 아니다(나중에 돌 수도 · 안 돌 수도).
    const later = escMarkSites('later.tsx', "function h(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); requestAnimationFrame(() => onClose()); } }");
    expect(later.map((s) => s.closes)).toEqual([false]);
    const sw = escMarkSites('switch.tsx', "function h(e: KeyboardEvent) { switch (e.key) { case 'Escape': e.preventDefault(); break; } }");
    expect(sw.map((s) => s.closes)).toEqual([false]);
  });

  // story #4408 — 실 트리 전수라 행 가드(story #4333)를 기본 5초보다 넉넉히: CI work 26 run(2026-09-28) 이 테스트 중앙값 3049ms · 최댓값 3676ms로 기본 5초의 74%까지 차 있었다(부하로 넘으면 까닭 없는 RED). 30초 ≈ 최댓값의 8.2배.
  it('앱 소스 — Esc에 표시하는 자리 전부가 같은 갈래에서 자기 층을 닫는다', () => {
    const sites = sourceFiles(SRC).flatMap((f) => escMarkSites(path.relative(SRC, f), fs.readFileSync(f, 'utf8')));
    // 훑개가 아무것도 못 찾아 초록이 되는 일이 없게 — 알려진 자리(새 폴더 둘 · 포털 메뉴 · 첨부 고르개 · flow 연결 초안 …)가 잡혀야 한다.
    expect(sites.length, JSON.stringify(sites.map((s) => `${s.file}:${s.line}`))).toBeGreaterThanOrEqual(6);
    const trapped = sites.filter((s) => !s.closes);
    expect(trapped, `닫지 않고 Esc에 표시만 하는 자리(바깥 창 · 시트 · 서랍 · 패널이 Esc로 안 닫힘):\n${trapped.map((s) => `${s.file}:${s.line} ${s.text}`).join('\n')}`).toEqual([]);
  }, 30_000);
});
