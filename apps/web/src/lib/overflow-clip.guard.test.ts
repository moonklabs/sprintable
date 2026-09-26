// [SID:4349] 부류 가드 — overflow 조상이 absolute 팝오버를 통째로 자르는 모양(축척 사다리 안내 팝오버가 어떤 폭에서도 안 보이던 결함).
// CSS 규칙(CSS 2.1 §11.1.1): overflow ≠ visible 인 요소 O는, **담는 블록**(가장 가까운 positioned 조상)이 O 자신이거나 O의 자손인 absolute 자손을 자른다.
//   → 팝오버 A의 담는 블록 CB가 overflow 조상 O의 안(또는 O 자신)이면 RED. CB가 O보다 위면(O가 CB와 A 사이) 안 잘린다.
// 처방은 부모 밖으로 그리기(`components/shared/anchored-popover.tsx` · createPortal). 포털 안은 보지 않는다.
// 한계: 같은 파일 안 JSX 조상만 본다(className 변수는 같은 파일 const 한 단계까지). 부모 컴포넌트(다른 파일)의 overflow는 PR 본문 전수 표로 메운다.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '..');
const ABS = /(?:^|\s)absolute(?:\s|$)/;
const ATTACHED = /(?:^|\s)(?:top-full|bottom-full|left-full|right-full)(?:\s|$)/;
const FLOATING = /(?:^|\s)mt-\d/;
const Z = /(?:^|\s)z-/;
const SURFACE = /bg-popover|bg-card|bg-background|shadow|elev-overlay/;
const POSITIONED = /(?:^|\s)(?:relative|absolute|fixed|sticky)(?:\s|$)|(?:^|\s)(?:transform|translate-|-translate-|scale-|rotate-)/;
const OVERFLOW = /(?:^|\s)overflow(?:-[xy])?-(?:hidden|auto|scroll|clip)(?:\s|$)|(?:^|\s)(?:truncate|line-clamp-\d)(?:\s|$)/;

const isPopover = (cls: string, attrs: string) =>
  ABS.test(cls) && (ATTACHED.test(cls) || (FLOATING.test(cls) && Z.test(cls))) &&
  (SURFACE.test(cls) || /role=["']?(tooltip|menu|listbox|dialog)/.test(attrs));

/** 한 파일에서 «잘리는 팝오버» 목록과 본 팝오버 수. */
export function clippedPopovers(src: string, file = 'sample.tsx'): { clipped: string[]; seen: number } {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const decls = new Map<string, ts.Node>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) decls.set(n.name.text, n.initializer);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const classOf = (o: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string => {
    const a = o.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'className') as ts.JsxAttribute | undefined;
    if (!a?.initializer) return '';
    const parts: string[] = [];
    const grab = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text);
      if (ts.isTemplateExpression(n)) { parts.push(n.head.text); n.templateSpans.forEach((s) => parts.push(s.literal.text)); }
      ts.forEachChild(n, grab);
    };
    grab(a.initializer);
    const ids: string[] = [];
    const idGrab = (n: ts.Node): void => { if (ts.isIdentifier(n) && n.text !== 'cn') ids.push(n.text); ts.forEachChild(n, idGrab); };
    idGrab(a.initializer);
    for (const id of ids) { const d = decls.get(id); if (d) grab(d); }
    return parts.join(' ');
  };
  const clipped: string[] = [];
  let seen = 0;
  const stack: { tag: string; cls: string; line: number }[] = [];
  const visit = (n: ts.Node, inPortal: boolean): void => {
    const portal = inPortal || (ts.isCallExpression(n) && /createPortal$/.test(n.expression.getText(sf)));
    let pushed = false;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const o = ts.isJsxElement(n) ? n.openingElement : n;
      const cls = classOf(o);
      const line = sf.getLineAndCharacterOfPosition(o.getStart()).line + 1;
      const tag = o.tagName.getText(sf);
      if (!portal && isPopover(cls, o.attributes.getText(sf))) {
        seen += 1;
        let cb = -1;
        for (let i = stack.length - 1; i >= 0; i -= 1) if (POSITIONED.test(stack[i].cls)) { cb = i; break; }
        const clip = cb < 0 ? [] : stack.slice(0, cb + 1).filter((s) => OVERFLOW.test(s.cls));
        if (clip.length) clipped.push(`${file}:${line} <${tag}> ← ${clip.map((s) => `${s.tag}:${s.line}`).join(' · ')}`);
      }
      stack.push({ tag, cls, line });
      pushed = true;
    }
    ts.forEachChild(n, (c) => visit(c, portal));
    if (pushed) stack.pop();
  };
  visit(sf, false);
  return { clipped, seen };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p, out); }
    else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

describe('overflow 조상 × absolute 팝오버 부류 가드([SID:4349])', () => {
  it('양성 대조 — 옛 축척 사다리 두 갈래는 RED · 담는 블록이 overflow보다 위면 · 포털이면 통과', () => {
    // compact(develop :158) — 칩 줄 overflow-x-auto 안의 relative wrapper가 담는 블록
    const compactOld = `<div className="flex items-center gap-1 overflow-x-auto rounded-lg"><div className="relative shrink-0"><button>작업</button>
      {open && <div role="tooltip" className="absolute left-0 top-full z-20 mt-2 w-56 rounded-lg border bg-popover p-3">안내</div>}</div></div>`;
    // 전체판(develop :256) — 담는 블록 className이 변수(rungClassName)
    const fullOld = `function L() { const rungClassName = cn('relative flex-1 border-r px-3', x && 'y');
      return <div className="flex overflow-hidden rounded-xl border"><div className={rungClassName}><button>작업</button>
      {open && <div role="tooltip" className="absolute left-3 top-full z-20 mt-2 w-56 rounded-lg border bg-popover p-3">안내</div>}</div></div>; }`;
    expect(clippedPopovers(compactOld).clipped).toHaveLength(1);
    expect(clippedPopovers(fullOld).clipped).toHaveLength(1);
    // overflow가 담는 블록과 팝오버 사이(담는 블록이 overflow보다 위) — 안 잘린다
    const escapes = `<div className="relative"><div className="overflow-hidden"><div className="absolute right-0 top-full z-50 mt-1 w-72 bg-popover">x</div></div></div>`;
    expect(clippedPopovers(escapes)).toEqual({ clipped: [], seen: 1 });
    // 포털(body) 안 — 안 본다
    const portaled = `<div className="overflow-hidden"><div className="relative">{createPortal(<div className="absolute top-full z-50 bg-popover">x</div>, document.body)}</div></div>`;
    expect(clippedPopovers(portaled)).toEqual({ clipped: [], seen: 0 });
  });

  it('src 전체 .tsx에 «overflow 조상이 담는 블록을 품은» absolute 팝오버 0곳 — 같은 길로 흘린 양성 대조 픽스처 하나만 잡힌다', () => {
    const files = walk(SRC);
    expect(files.length, '스캔 재료가 비지 않았다(조용한 0 방지)').toBeGreaterThan(300);
    // 조용한 0 방지(PO 11:52Z) — 숫자 바닥 대신, 잘리는 모양 픽스처 하나를 **실제 파일과 같은 길**(같은 거르개 · 같은 스캐너)로 흘린다.
    // 스캐너가 망가져 아무것도 못 보면 픽스처가 안 잡혀 RED · 픽스처를 고치면(포털 · overflow 걷기) RED. 기록만: 이 판 src에서 본 팝오버 12곳.
    const FIXTURE = '__positive-control__/list-row-menu.tsx';
    const fixtureSrc = `<div className="flex-1 overflow-y-auto p-2"><div className="relative"><button>행</button>
      {open && <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border bg-popover p-1">메뉴</div>}</div></div>`;
    const inputs: Array<[string, string]> = [...files.map((f) => [path.relative(SRC, f), fs.readFileSync(f, 'utf8')] as [string, string]), [FIXTURE, fixtureSrc]];
    const clipped: string[] = [];
    for (const [rel, src] of inputs) {
      if (!/absolute/.test(src)) continue;
      clipped.push(...clippedPopovers(src, rel).clipped);
    }
    expect(clipped).toEqual([expect.stringMatching(new RegExp(`^${FIXTURE}:2 <div> ← div:1`))]);
  });
});
