// story #4325 — 색 토큰은 **완성된 색**(`--border: var(--proof-line)` → `#E7E4DE` · oklch …)이다. 그걸 `hsl(var(--border))`처럼 색 함수로
// 감싸면 `hsl(#E7E4DE)`가 되어 **선언 전체가 무효** — 테두리는 글자색으로, 배경은 투명으로, 그림자 링은 사라졌다(develop 다섯 줄).
// 이 저장소엔 HSL 성분(`210 40% 98%`)만 담는 토큰이 없다(아래 테스트가 고정) — 그래서 `hsl/hsla/rgb/rgba(var(--…))` 모양은 늘 틀린 것.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');
// 앞 글자 경계는 \b가 아니라 «영숫자 · 하이픈이 아님» — Tailwind 임의값 `1px_hsl(…)`의 `_` 뒤도 잡는다(\b는 `_`를 단어 글자로 봐서 놓쳤다).
// 까디르 QA(4686 P3) — 대문자(`HSL(`) · `var( --x )` 공백 · 폴백 인자(`var(--x, #fff)` · Tailwind `var(--x,_#fff)`)도 같은 결함이다: 이름 뒤가
// `)`이든 `,`이든 감싼 것. 대소문자 무시.
const WRAP_RE = /(?<![A-Za-z0-9-])(?:hsla?|rgba?)\(\s*var\(\s*--[\w-]+\s*[,)]/gi;
const BARE_COMPONENT_TOKEN_RE = /^\s*--[a-z0-9-]+:\s*[\d.]+(?:deg)?\s+[\d.]+%\s+[\d.]+%/m;


function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== '.next') files(p, out); }
    else if (/\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** 문자열 하나 안의 감싼 토큰 수. */
export function countWrapped(text: string): number {
  return (text.match(WRAP_RE) ?? []).length;
}

/**
 * 파일 하나의 감싼 토큰 수 — **주석은 세지 않는다**(까디르 QA 4686 P2: 주석 한 줄이 면제를 붙잡았다). CSS는 `/* … *\/`를 걷고,
 * TS/TSX는 AST에서 코드가 실제로 쓰는 글자(문자열 · 템플릿 조각 · JSX 텍스트)만 본다 — 주석은 AST 노드가 아니라 애초에 안 보인다.
 */
export function findWrappedTokens(text: string, file = 'x.tsx'): number {
  if (file.endsWith('.css')) return countWrapped(text.replace(/\/\*[\s\S]*?\*\//g, ''));
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      n += countWrapped(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

function scan(root = SRC): Record<string, number> {
  const byFile: Record<string, number> = {};
  for (const abs of files(root)) {
    const n = findWrappedTokens(readFileSync(abs, 'utf8'), abs);
    if (n) byFile[path.relative(root, abs).split(path.sep).join('/')] = n;
  }
  return byFile;
}

describe('색 토큰을 색 함수로 감싸지 않는다(story #4325)', () => {
  it('양성 — CSS 선언 · Tailwind 임의값 · 그림자 · 공백 · hsla/rgb/rgba', () => {
    expect(findWrappedTokens('.a { border-color: hsl(var(--border)); }', 'a.css')).toBe(1);
    expect(findWrappedTokens("const c = 'border-[hsl(var(--border))] bg-[hsl(var(--muted))]/20';")).toBe(2);
    expect(findWrappedTokens("const c = 'shadow-[0_0_0_1px_hsl(var(--sidebar-border))]';")).toBe(1);
    expect(findWrappedTokens('.a { color: rgba( var(--x) / 0.5); background: hsla(var(--y), 1) }', 'a.css')).toBe(2);
  });

  it('⭐양성 — 까디르 QA 4686 P3: 폴백 인자 · var( ) 안 공백 · 대문자', () => {
    expect(findWrappedTokens('.a { border-color: hsl(var(--border, #fff)); }', 'a.css'), '폴백 인자').toBe(1);
    expect(findWrappedTokens("const c = 'border-[hsl(var(--border,_#fff))]';"), 'Tailwind 폴백(_)').toBe(1);
    expect(findWrappedTokens('.a { color: hsl(var( --border )); }', 'a.css'), 'var( ) 안 공백').toBe(1);
    expect(findWrappedTokens('.a { color: HSL(var(--border)); background: Rgba(var(--x)) }', 'a.css'), '대문자').toBe(2);
    expect(findWrappedTokens('const s = `border-[hsl(var(--${name}))]`;'), '템플릿 조각').toBe(0); // 이름이 치환이면 어떤 토큰인지 모른다 — 세지 않음(아래 음성)
    expect(findWrappedTokens('<div style={{}}>hsl(var(--border))</div>'), 'JSX 텍스트').toBe(1);
  });

  it('⭐음성 — 까디르 QA 4686 P2: 주석은 세지 않는다(TS 한 줄 · 여러 줄 · CSS)', () => {
    expect(findWrappedTokens('// 예전 `hsl(var(--border))`는 무효였다\nconst a = 1;')).toBe(0);
    expect(findWrappedTokens('/* hsl(var(--border)) */ const a = 1;')).toBe(0);
    expect(findWrappedTokens('/* hsl(var(--border)) */ .a { color: var(--border); }', 'a.css')).toBe(0);
  });

  it('음성 — var() 그대로 · color-mix · 숫자 인자 hsl() · 토큰 정의', () => {
    expect(findWrappedTokens('.a { border-color: var(--border); }', 'a.css')).toBe(0);
    expect(findWrappedTokens("const c = 'shadow-[0_0_0_1px_var(--sidebar-border)]';")).toBe(0);
    expect(findWrappedTokens('.a { color: color-mix(in oklch, var(--border) 50%, transparent) }', 'a.css')).toBe(0);
    expect(findWrappedTokens('.a { color: hsl(210 40% 98%) }', 'a.css')).toBe(0);
  });

  it('전제 — HSL 성분만 담는 토큰이 없다(있으면 hsl(var()) 가 맞는 자리가 생겨 이 가드를 다시 봐야 한다)', () => {
    const css = files(SRC).filter((f) => f.endsWith('.css')).map((f) => readFileSync(f, 'utf8'));
    expect(css.some((t) => BARE_COMPONENT_TOKEN_RE.test(t))).toBe(false);
  });

  it('⭐실 저장소 — 감싼 토큰 0(면제 없음 · 까디르 QA 4686 P2: 4684는 병합됐고 남은 매치는 주석뿐이었다)', () => {
    expect(scan()).toEqual({});
  });
});
