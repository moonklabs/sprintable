// story #4231 다음 조각(래칫 맹점 ② · PO 11:23Z 전수 · 14:07Z) — 채팅은 조직 전체가 보는 자리라 **대상 링크**(스토리 · 문서 · 게이트 · 목표 …)는
// 현재 p가 아니라 대상 자기 프로젝트를 실어야 한다(4231 4차 규칙 · 4612 교훈). 기존 flat 래칫은 `flatHref`로 감싼 것을 «bare 아님»으로 세
// 이 부류(현재 p를 싣는 대상 링크)를 못 봤다.
// 셈: components/chat · components/chat-v3 안에서 현재 p 래퍼(`flatHref`)를 **대상 링크**에 쓰는 자리 —
//   ① `flatHref`를 링크 조립 함수(getEntityHref · renderStaticEventBlock · …)의 인자로 넘김 ② `flatHref(<대상 경로 리터럴>)`.
// 허용: 그 문장 바로 위(또는 같은 줄) 주석에 `대상-프로젝트:` + 이유(대상 프로젝트를 모름 · 현재 p가 곧 대상 프로젝트인 이유)가 있을 때만.
// 이 수가 늘면 RED(새 자리는 대상 프로젝트를 싣거나 이유를 적는다).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const BASELINE = 0;

const SRC = path.resolve(__dirname, '..');
const DIRS = ['components/chat', 'components/chat-v3'];
const CURRENT_P = 'flatHref';
const REASON_MARK = '대상-프로젝트:';
// 대상(항목) 경로 — flat 목적지 중 «특정 항목»을 가리키는 것.
const TARGET_PATH = /^\/(gates\/|docs(\?id=|\/)|board\?story=|goals\/|artifacts\/|loops\/|storage\?asset=|sprints\/|chats\/)/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.includes('.test.') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function literalHead(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return null;
}

/** 노드가 든 문장(가장 가까운 Statement · JSX 속성 · 객체 속성)의 앞 주석 · 같은 줄에 이유 표시가 있는지. */
function hasReason(sf: ts.SourceFile, node: ts.Node, text: string): boolean {
  let n: ts.Node = node;
  while (n.parent && !ts.isStatement(n) && !ts.isJsxAttribute(n) && !ts.isPropertyAssignment(n)) n = n.parent;
  const start = n.getFullStart();
  const leading = text.slice(start, n.getStart(sf));
  const lineEnd = text.indexOf('\n', node.getEnd());
  const sameLine = text.slice(node.getEnd(), lineEnd < 0 ? undefined : lineEnd);
  // 여러 줄 식 한가운데 갈래(예: 삼항의 폴백 갈래)는 문장 앞이 아니라 그 호출 바로 윗줄에 적는다 — 그 줄도 본다.
  const lineStart = text.lastIndexOf('\n', node.getStart(sf) - 1);
  const prevLineStart = text.lastIndexOf('\n', lineStart - 1);
  const prevLine = lineStart < 0 ? '' : text.slice(prevLineStart + 1, lineStart);
  const ownLineHead = text.slice(lineStart + 1, node.getStart(sf));
  return leading.includes(REASON_MARK) || sameLine.includes(REASON_MARK) || prevLine.includes(REASON_MARK) || ownLineHead.includes(REASON_MARK);
}

export function countCurrentProjectTargetLinks(fileName: string, text: string): number {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === CURRENT_P) {
        const head = node.arguments[0] ? literalHead(node.arguments[0]) : null;
        if (head !== null && TARGET_PATH.test(head) && !hasReason(sf, node, text)) n += 1;
      } else if (node.arguments.some((a) => ts.isIdentifier(a) && a.text === CURRENT_P) && !hasReason(sf, node, text)) {
        n += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

function scan(): { total: number; byFile: Record<string, number> } {
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const d of DIRS) {
    for (const file of sourceFiles(path.join(SRC, d))) {
      const k = countCurrentProjectTargetLinks(file, readFileSync(file, 'utf8'));
      if (k) { byFile[path.relative(SRC, file)] = k; total += k; }
    }
  }
  return { total, byFile };
}

describe('채팅 대상 링크의 현재 p 래칫(#4231 다음 조각 · 맹점 ②)', () => {
  const count = (src: string) => countCurrentProjectTargetLinks('x.tsx', src);

  it('양성대조 — 대상 링크 조립에 현재 p · 대상 경로를 현재 p로 감쌈', () => {
    expect(count('const h = getEntityHref(t, id, flatHref);')).toBe(1);
    expect(count('const a = <Link href={flatHref(`/gates/${g.id}`)} />;')).toBe(1);
    expect(count("const a = <Link href={flatHref(`/docs?id=${d}`)} />;")).toBe(1);
    expect(count('const b = renderStaticEventBlock(block, 0, flatHref);')).toBe(1);
  });

  it('음성대조 — 대상 프로젝트로 감쌈 · 목록/화면 경로 · 이유 주석', () => {
    expect(count('const h = getEntityHref(t, id, (x) => withProjectParam(x, pid));')).toBe(0);
    expect(count("const a = <Link href={flatHref('/inbox?tab=gates')} />;")).toBe(0);
    expect(count("const a = <Link href={flatHref('/chats')} />;")).toBe(0);
    expect(count('// 대상-프로젝트: 메시지 참조엔 대상 프로젝트가 없다\nconst h = getEntityHref(t, id, flatHref);')).toBe(0);
    expect(count('const h = getEntityHref(t, id, flatHref); // 대상-프로젝트: 모름')).toBe(0);
    expect(count('const a = <Link\n  // 대상-프로젝트: 게이트 id만 안다\n  href={flatHref(`/gates/${id}`)}\n/>;')).toBe(0);
  });

  it(`⭐채팅 대상 링크의 현재 p(이유 없음) = ${BASELINE}(늘면 RED)`, () => {
    const { total, byFile } = scan();
    expect(total, `이유 없이 현재 p를 싣는 채팅 대상 링크 ${total}개:\n${JSON.stringify(byFile, null, 1)}`).toBe(BASELINE);
  });
});
