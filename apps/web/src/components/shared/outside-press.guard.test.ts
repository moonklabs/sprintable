// [SID:4349 PR 2 · 유나 #4728] 부류 가드 — document 바깥 누름 닫기(`.contains(e.target)`)를 가진 컴포넌트가 포털 팝오버(AnchoredPopover)를
// 직접 또는 자식 컴포넌트를 거쳐 그리면, 그 판정은 공용 `isOutsidePress`(components/shared/anchored-popover.tsx)를 써야 한다.
// 안 쓰면 body로 포털된 메뉴 안 누름이 «바깥»으로 세어진다 → 부모가 mousedown에서 먼저 닫히고 자식 메뉴가 언마운트돼 click이 안 온다
// (390 문서 담당자 창 → «더 보기» → «이벤트 전달» 탭 = 디스패치 요청 0).
// 방법(소스 AST · 읽기만):
//   ① 파일마다 대문자 이름 컴포넌트와 그 본문의 JSX 태그 이름을 모은다.
//   ② <AnchoredPopover>를 그리는 컴포넌트에서 시작해, 그 컴포넌트를 태그로 쓰는 컴포넌트로 위로 닫는다(슬롯 prop으로 넘긴 JSX도 그 JSX를 쓰는 쪽에서 잡힌다).
//   ③ 닫힘 안 컴포넌트 본문의 document/window.addEventListener('mousedown' | 'pointerdown' | 'touchstart' | 'click', h)에서
//      h 본문(인라인이거나 같은 컴포넌트 안 선언)이 `.contains(`를 쓰는데 `isOutsidePress(`가 없으면 RED.
// 한계: 이름으로 잇는다(같은 이름의 다른 컴포넌트까지 넓게 잡힘 — 거짓 양성 쪽). 바깥 누름을 커스텀 훅 안에서 거는 자리는 못 본다(지금 0곳).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '../..');
const EVENTS = new Set(['mousedown', 'pointerdown', 'touchstart', 'click']);

type Comp = { name: string; file: string; tags: Set<string>; listeners: { line: number; handler: string }[] };

function componentsOf(file: string, src: string): Comp[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const comps: Comp[] = [];
  const nameOf = (n: ts.Node): string | null => {
    if (ts.isFunctionDeclaration(n) && n.name && /^[A-Z]/.test(n.name.text)) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z]/.test(n.name.text) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer) || ts.isCallExpression(n.initializer))) return n.name.text;
    return null;
  };
  const unwrap = (e: ts.Expression): ts.Expression => (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);
  const visit = (n: ts.Node, comp: Comp | null, body: ts.Node | null): void => {
    const name = nameOf(n);
    if (name) {
      const c: Comp = { name, file, tags: new Set(), listeners: [] };
      comps.push(c);
      ts.forEachChild(n, (ch) => visit(ch, c, n));
      return;
    }
    if (comp && (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))) comp.tags.add(n.tagName.getText(sf));
    if (comp && body && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'addEventListener'
      && /^(document|window)$/.test(n.expression.expression.getText(sf)) && n.arguments.length >= 2) {
      const ev = n.arguments[0];
      if (ts.isStringLiteral(ev) && EVENTS.has(ev.text)) {
        const h = unwrap(n.arguments[1]);
        let text = h.getText(sf);
        if (ts.isIdentifier(h)) {
          // 같은 컴포넌트 안에서 그 이름의 선언을 찾는다(const h = … · function h() {}).
          const find = (m: ts.Node): string | null => {
            if (ts.isVariableDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === h.text && m.initializer) return m.initializer.getText(sf);
            if (ts.isFunctionDeclaration(m) && m.name?.text === h.text) return m.getText(sf);
            let hit: string | null = null;
            ts.forEachChild(m, (ch) => { hit ??= find(ch); });
            return hit;
          };
          text = find(body) ?? text;
        }
        comp.listeners.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, handler: text });
      }
    }
    ts.forEachChild(n, (ch) => visit(ch, comp, body));
  };
  visit(sf, null, null);
  return comps;
}

/** 포털 팝오버를 (거쳐) 그리면서 `.contains(`로 바깥을 재고 `isOutsidePress`를 안 쓰는 자리 — `파일:줄 (컴포넌트)`. */
export function outsidePressViolations(inputs: Array<[string, string]>): { violations: string[]; reaching: number; checked: number; report: string[] } {
  const comps = inputs.flatMap(([f, s]) => componentsOf(f, s));
  const reach = new Set(comps.filter((c) => c.tags.has('AnchoredPopover')).map((c) => c.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const c of comps) if (!reach.has(c.name) && [...c.tags].some((t) => reach.has(t))) { reach.add(c.name); grew = true; }
  }
  const violations: string[] = [];
  const report: string[] = [];
  let checked = 0;
  for (const c of comps) {
    for (const l of c.listeners) {
      report.push(`${c.file}:${l.line} (${c.name}) 포털 닿음=${reach.has(c.name) ? '예' : '아니오'} · contains=${/\.contains\(/.test(l.handler) ? '예' : '아니오'} · isOutsidePress=${/\bisOutsidePress\(/.test(l.handler) ? '예' : '아니오'}`);
    }
    if (!reach.has(c.name)) continue;
    for (const l of c.listeners) {
      if (!/\.contains\(/.test(l.handler)) continue;
      checked += 1;
      if (!/\bisOutsidePress\(/.test(l.handler)) violations.push(`${c.file}:${l.line} (${c.name})`);
    }
  }
  return { violations, reaching: reach.size, checked, report };
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__tests__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$|\.d\.ts$|\.fixture\.ts$/.test(e.name) ? [p] : [];
  });
}

// 같은 경로 양성 대조 — 실 트리와 함께 넣어, 이것이 **유일한** 걸림이어야 한다(가드가 눈멀면 이게 안 잡혀 RED).
const FIXTURE = 'components/__outside-press-fixture__.tsx';
const FIXTURE_SRC = `
function OutsidePressFixtureMenu() { return <AnchoredPopover anchorRef={a} popoverRef={b}><button>항목</button></AnchoredPopover>; }
export function OutsidePressFixtureParent() {
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return <div ref={ref}><OutsidePressFixtureMenu /></div>;
}`;

describe('부류 가드 — 포털 팝오버를 품은 바깥 누름 닫기는 isOutsidePress(story #4349 PR 2 · 유나 #4728)', () => {
  // story #4408 — 실 트리 전수라 행 가드(story #4333)를 기본 5초보다 넉넉히: CI work 26 run(2026-09-28) 이 테스트 중앙값 3526ms · 최댓값 4099ms로 기본 5초의 82%까지 차 있었다(부하로 넘으면 까닭 없는 RED). 30초 ≈ 최댓값의 7.3배.
  it('실 트리 + 같은 경로 양성 대조: 걸림은 대조 하나뿐', () => {
    const files = sourceFiles(SRC);
    const inputs: Array<[string, string]> = [...files.map((f) => [path.relative(SRC, f), fs.readFileSync(f, 'utf8')] as [string, string]), [FIXTURE, FIXTURE_SRC]];
    const { violations, reaching, checked, report } = outsidePressViolations(inputs);
    // 전수 표용(PR 댓글): OUTSIDE_PRESS_REPORT=<파일 경로>면 리스너마다 «포털 닿음 · contains · isOutsidePress»를 적는다.
    if (process.env.OUTSIDE_PRESS_REPORT) fs.writeFileSync(process.env.OUTSIDE_PRESS_REPORT, report.join('\n') + '\n');
    expect(violations).toEqual([`${FIXTURE}:6 (OutsidePressFixtureParent)`]);
    // 참고치(하한 아님): 포털 팝오버에 닿는 컴포넌트 수 · `.contains(`로 바깥을 재는 리스너 수
    console.info(`[outside-press guard] reaching=${reaching} checked=${checked}`);
  }, 30_000);

  it('대조를 공용 규칙으로 고치면 0 · 포털을 안 품으면 .contains만 써도 대상 아님', () => {
    const fixed = FIXTURE_SRC.replace('if (ref.current && !ref.current.contains(e.target as Node)) close();', 'if (isOutsidePress(ref.current, e.target)) close();');
    expect(outsidePressViolations([[FIXTURE, fixed]]).violations).toEqual([]);
    const noPortal = FIXTURE_SRC.replace('<AnchoredPopover anchorRef={a} popoverRef={b}><button>항목</button></AnchoredPopover>', '<ul><li>항목</li></ul>');
    expect(outsidePressViolations([[FIXTURE, noPortal]]).violations).toEqual([]);
  });

  it('슬롯으로 넘긴 포털 품은 자식도 그 JSX를 쓰는 부모에서 잡힌다 · 핸들러가 function 선언이어도', () => {
    const src = `
function SlotFixtureMenu() { return <AnchoredPopover anchorRef={a} popoverRef={b} />; }
export function SlotFixturePage() {
  useEffect(() => {
    function onDown(e: PointerEvent) { if (!panel.current?.contains(e.target as Node)) hide(); }
    window.addEventListener('pointerdown', onDown as EventListener);
  }, []);
  return <Editor slot={<SlotFixtureMenu />} />;
}`;
    expect(outsidePressViolations([['x.tsx', src]]).violations).toEqual(['x.tsx:6 (SlotFixturePage)']);
  });
});
