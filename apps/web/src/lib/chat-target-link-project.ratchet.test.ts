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
// story #4231 다음 조각 5(PO 12:17Z) — 채팅만 보던 자를 **조직 전체가 보는 화면**으로 넓힌다(항목마다 프로젝트가 다를 수 있는 곳).
// 프로젝트 안 화면(스프린트 · 목표 · 루프 · 스토리 패널 · 작업 목록 · 스토리지)은 현재 p = 대상 프로젝트라 대상이 아니다.
const DIRS = [
  'components/chat', 'components/chat-v3',
  'app/(authenticated)/organization', 'app/(authenticated)/content', 'app/(authenticated)/gates', 'app/(authenticated)/inbox',
  'components/today-v3', 'components/org-briefing', 'components/verify', 'components/dashboard', 'components/inbox',
];
const CURRENT_P = 'flatHref';
/** 이 파일에서 «현재 p» 함수로 쓰이는 이름 — 이름만 바꿔 넘기면 못 셌다(맹점). 셈하는 모양(모든 모양을 쫓진 않는다 · PO 4669):
 *  `const X = useFlatHref()` · `const/let X = <현재 p>` · `const X = useCallback(<현재 p>…)` · `useCallback((h) => <현재 p>(h), …)` ·
 *  구조 분해 `const { flatHref: X } = …` / `const { X } = { X: <현재 p> }`. 별칭의 별칭도(고정점까지). */
function currentProjectNames(sf: ts.SourceFile): Set<string> {
  const names = new Set([CURRENT_P]);
  const isCur = (e: ts.Node | undefined): boolean => !!e && ts.isIdentifier(e) && names.has(e.text);
  const wrapsCurrent = (e: ts.Expression): boolean => {
    if (isCur(e)) return true;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      if (e.expression.text === 'useFlatHref') return true;
      if (e.expression.text === 'useCallback' || e.expression.text === 'useMemo') {
        const fn = e.arguments[0];
        if (!fn) return false;
        if (isCur(fn)) return true;
        // useCallback((h) => flatHref(h), …) · useMemo(() => flatHref, …)
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
          const body = fn.body;
          if (ts.isArrowFunction(fn) && !ts.isBlock(body)) return isCur(body) || (ts.isCallExpression(body) && isCur(body.expression));
        }
      }
    }
    return false;
  };
  let grew = true;
  while (grew) {
    const before = names.size;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name) && wrapsCurrent(node.initializer)) names.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            // `const { flatHref: X } = …`(현재 p를 이름으로 꺼냄) · `const { X } = { X: flatHref }`(객체 리터럴에서 현재 p를 꺼냄).
            const fromLiteral = ts.isObjectLiteralExpression(node.initializer) && node.initializer.properties.some((pr) =>
              (ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name) && pr.name.text === key && isCur(pr.initializer))
              || (ts.isShorthandPropertyAssignment(pr) && pr.name.text === key && names.has(key)));
            if (names.has(key) || fromLiteral) names.add(el.name.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    grew = names.size > before;
  }
  return names;
}
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
  return [leading, sameLine, prevLine, ownLineHead].some(hasFilledReason);
}

// 표지 뒤에 이유 글자가 있어야 허용(PO 4669 반려) — 줄 주석이든 JSX 블록 주석이든 표지 뒤가 비면(주석 닫는 글자만 있어도) 셈에 남는다.
export function hasFilledReason(chunk: string): boolean {
  let at = chunk.indexOf(REASON_MARK);
  while (at >= 0) {
    // 이유는 표지 뒤 그 주석 안의 글자만 — 줄 끝 또는 블록 주석 닫힘(`*` `/`)까지.
    const rest = chunk.slice(at + REASON_MARK.length).split('\n')[0].split('*/')[0].trim();
    if (rest.length > 0) return true;
    at = chunk.indexOf(REASON_MARK, at + REASON_MARK.length);
  }
  return false;
}

export function countCurrentProjectTargetLinks(fileName: string, text: string): number {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  const current = currentProjectNames(sf);
  const isCurrent = (e: ts.Node | undefined) => !!e && ts.isIdentifier(e) && current.has(e.text);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (current.has(callee)) {
        const head = node.arguments[0] ? literalHead(node.arguments[0]) : null;
        if (head !== null && TARGET_PATH.test(head) && !hasReason(sf, node, text)) n += 1;
      // 훅 인자(useRef · useCallback 의존성 · useMemo …)는 대상 링크 조립이 아니다.
      } else if (!/^use[A-Z]/.test(callee) && node.arguments.some(isCurrent) && !hasReason(sf, node, text)) {
        n += 1;
      }
    }
    // 맹점: 현재 p를 **prop으로** 대상 링크 조립 컴포넌트에 넘김(`withProject={flatHref}`) — 그 컴포넌트 안에선 이름이 달라 못 셌다.
    if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && isCurrent(node.initializer.expression)
      && !hasReason(sf, node, text)) n += 1;
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

describe('대상 링크의 현재 p 래칫(#4231 다음 조각 · 맹점 ② · 조직 전체 화면)', () => {
  const count = (src: string) => countCurrentProjectTargetLinks('x.tsx', src);

  it('양성대조 — 대상 링크 조립에 현재 p · 대상 경로를 현재 p로 감쌈', () => {
    expect(count('const h = getEntityHref(t, id, flatHref);')).toBe(1);
    expect(count('const a = <Link href={flatHref(`/gates/${g.id}`)} />;')).toBe(1);
    expect(count("const a = <Link href={flatHref(`/docs?id=${d}`)} />;")).toBe(1);
    expect(count('const b = renderStaticEventBlock(block, 0, flatHref);')).toBe(1);
  });

  it('⭐별칭 · prop 전달 — useFlatHref() 결과를 다른 이름으로 받아도 · 컴포넌트에 prop으로 넘겨도 센다', () => {
    expect(count('const toP = useFlatHref();\nconst h = getEntityHref(t, id, toP);')).toBe(1);
    expect(count('const toP = useFlatHref();\nconst a = <Link href={toP(`/gates/${g.id}`)} />;')).toBe(1);
    expect(count('const a = <EmbedCard withProject={flatHref} />;')).toBe(1);
    expect(count('// 대상-프로젝트: 메시지 참조엔 대상 프로젝트가 없다\nconst a = <EmbedCard withProject={flatHref} />;')).toBe(0);
    expect(count('const f = useCallback(() => 1, [flatHref]);'), '의존성 배열은 전달 아님').toBe(0);
  });

  it('⭐별칭 모양 넓힘(PO 4669) — const/let 대입 · 별칭의 별칭 · useCallback 감쌈 · 구조 분해', () => {
    expect(count('const x = flatHref;\nconst h = getEntityHref(t, id, x);')).toBe(1);
    expect(count('let x = flatHref;\nconst a = <Link href={x(`/gates/${g}`)} />;')).toBe(1);
    expect(count('const x = flatHref;\nconst y = x;\nconst h = getEntityHref(t, id, y);'), '별칭의 별칭').toBe(1);
    expect(count('const w = useCallback(flatHref, []);\nconst h = getEntityHref(t, id, w);')).toBe(1);
    expect(count('const w = useCallback((h) => flatHref(h), [flatHref]);\nconst a = <Link href={w(`/chats/${c}`)} />;')).toBe(1);
    expect(count('const { flatHref: go } = ctx;\nconst h = getEntityHref(t, id, go);')).toBe(1);
    expect(count('const { go } = { go: flatHref };\nconst h = getEntityHref(t, id, go);')).toBe(1);
    // 음성 — 현재 p와 무관한 이름은 세지 않는다.
    expect(count('const x = other;\nconst h = getEntityHref(t, id, x);')).toBe(0);
  });

  it('⭐이유 표지 뒤가 비면 허용 안 함(PO 4669) — 표지만 달고 이유를 안 쓰면 셈에 남는다', () => {
    expect(count('// 대상-프로젝트:\nconst h = getEntityHref(t, id, flatHref);')).toBe(1);
    expect(count('// 대상-프로젝트:   \nconst h = getEntityHref(t, id, flatHref);')).toBe(1);
    expect(count('const a = <div>{/* 대상-프로젝트: */}<Link href={flatHref(`/gates/${g}`)} /></div>;')).toBe(1);
    expect(count('const a = <div>{/* 대상-프로젝트: 게이트 id만 안다 */}<Link href={flatHref(`/gates/${g}`)} /></div>;')).toBe(0);
    expect(hasFilledReason('// 대상-프로젝트: 모름')).toBe(true);
    expect(hasFilledReason('// 대상-프로젝트:')).toBe(false);
    expect(count('const r = useRef(flatHref);'), '훅 인자는 대상 링크 조립 아님').toBe(0);
  });

  it('음성대조 — 대상 프로젝트로 감쌈 · 목록/화면 경로 · 이유 주석', () => {
    expect(count('const h = getEntityHref(t, id, (x) => withProjectParam(x, pid));')).toBe(0);
    expect(count("const a = <Link href={flatHref('/inbox?tab=gates')} />;")).toBe(0);
    expect(count("const a = <Link href={flatHref('/chats')} />;")).toBe(0);
    expect(count('// 대상-프로젝트: 메시지 참조엔 대상 프로젝트가 없다\nconst h = getEntityHref(t, id, flatHref);')).toBe(0);
    expect(count('const h = getEntityHref(t, id, flatHref); // 대상-프로젝트: 모름')).toBe(0);
    expect(count('const a = <Link\n  // 대상-프로젝트: 게이트 id만 안다\n  href={flatHref(`/gates/${id}`)}\n/>;')).toBe(0);
  });

  it('자가 실제로 넓다 — 조직 전체 화면 폴더가 다 있다(이름 바뀜으로 헛돌지 않게)', () => {
    for (const d of DIRS) expect(statSync(path.join(SRC, d)).isDirectory(), d).toBe(true);
  });

  it(`⭐대상 링크의 현재 p(이유 없음) = ${BASELINE}(늘면 RED)`, () => {
    const { total, byFile } = scan();
    expect(total, `이유 없이 현재 p를 싣는 대상 링크 ${total}개:\n${JSON.stringify(byFile, null, 1)}`).toBe(BASELINE);
  });
});
