/**
 * 테스트 전용(번들 밖) — UI-3(a9d56577) 기기 꼴별 CSS 판정 보조.
 * jsdom은 미디어 쿼리를 안 돌린다. 그래서 «실제로 쓰는 클래스»를 Tailwind로 컴파일하고(변형 정의는 design-system.css 소스에서 그대로 꺼낸다),
 * 컴파일된 중첩 CSS를 기기 꼴(pointer · hover · 앱 셸 표지 · 행 호버/초점)별로 읽어 한 속성의 «이기는 값»을 구한다.
 * 이 파일이 아는 모양만 읽는다 — 모르는 미디어 쿼리 · 선택자는 던진다(조용히 초록이 되지 않게).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from 'tailwindcss';

export type Env = {
  pointer: 'fine' | 'coarse';
  hover: 'hover' | 'none';
  /** `<html data-sprintable-shell>` 값 — 없으면 앱 밖(브라우저). */
  shell?: string | null;
  /** 행(`.group`)에 마우스가 올라와 있다. */
  rowHover?: boolean;
  /** 행(`.group`) 안에 초점이 있다. */
  rowFocus?: boolean;
  /** 요소 자신이(자식 포함) 초점을 쥐고 있다. */
  selfFocus?: boolean;
};

const CSS_SOURCE = readFileSync(resolve(__dirname, '../styles/design-system.css'), 'utf-8');

/** `@custom-variant <name> { … }` 블록을 CSS 소스에서 그대로 꺼낸다. */
export function variantBlock(name: string): string {
  const start = CSS_SOURCE.indexOf(`@custom-variant ${name} `);
  if (start < 0) throw new Error(`design-system.css에 @custom-variant ${name}이 있어야 한다`);
  let depth = 0;
  for (let i = CSS_SOURCE.indexOf('{', start); i < CSS_SOURCE.length; i++) {
    if (CSS_SOURCE[i] === '{') depth++;
    if (CSS_SOURCE[i] === '}' && --depth === 0) return CSS_SOURCE.slice(start, i + 1);
  }
  throw new Error(`@custom-variant ${name} 블록이 닫히지 않음`);
}

type Node = { head: string; decls: Array<[string, string]>; children: Node[] };
function parseCss(css: string): Node {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root: Node = { head: '', decls: [], children: [] };
  const stack: Node[] = [root];
  let buf = '';
  const flushDecl = () => {
    const t = buf.trim();
    buf = '';
    if (!t) return;
    const i = t.indexOf(':');
    stack[stack.length - 1]!.decls.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]);
  };
  for (const ch of text) {
    if (ch === '{') {
      const node: Node = { head: buf.trim(), decls: [], children: [] };
      buf = '';
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
    } else if (ch === '}') {
      flushDecl();
      stack.pop();
    } else if (ch === ';') {
      flushDecl();
    } else buf += ch;
  }
  return root;
}

function mediaApplies(params: string, env: Env): boolean {
  // 쉼표 = 또는 · and = 그리고. 아는 특성: pointer · hover.
  return params.split(',').some((term) =>
    term.split(/\s+and\s+/i).every((cond) => {
      const m = /^\s*\((pointer|hover)\s*:\s*([a-z]+)\)\s*$/.exec(cond);
      if (!m) throw new Error(`시험이 모르는 미디어 쿼리: ${cond}`);
      return env[m[1] as 'pointer' | 'hover'] === m[2];
    }),
  );
}
/** `:root[data-sprintable-shell="ios"] *, :root[…="android"] *` 같은 조상 목록 — 환경의 표지가 목록 안에 있는가. */
function shellListHas(list: string, env: Env): boolean {
  return list.split(',').some((part) => {
    const a = /^\s*:root\[data-sprintable-shell="([a-z]+)"\]\s*\*\s*$/.exec(part);
    if (!a) throw new Error(`시험이 모르는 조상 선택자(:root[data-sprintable-shell=…] * 만 안다): ${part}`);
    return env.shell === a[1];
  });
}
function selectorApplies(head: string, env: Env): boolean {
  let m = /^&:where\(:not\((.*)\)\)$/.exec(head);
  if (m) return !shellListHas(m[1]!, env);
  m = /^&:where\((.*)\)$/.exec(head);
  if (m) return shellListHas(m[1]!, env);
  if (head === '&:is(:where(.group):hover *)') return !!env.rowHover;
  if (head === '&:is(:where(.group):focus-within *)') return !!env.rowFocus;
  if (head === '&:focus-within') return !!env.selfFocus;
  throw new Error(`시험이 모르는 선택자: ${head}`);
}
function nodeApplies(head: string, env: Env): boolean {
  return head.startsWith('@media') ? mediaApplies(head.slice('@media'.length), env) : selectorApplies(head, env);
}

type Decl = { prop: string; value: string; when: (e: Env) => boolean };
export type Probe = { classes: Map<string, Decl[]>; order: string[] };

/** 클래스들을 컴파일해 («읽을 속성»만) 기기 꼴 판정용 색인을 만든다. 변형 정의는 design-system.css에서 꺼낸 `variants` 이름들. */
export async function buildProbe(classes: string[], variants: string[], props: string[]): Promise<Probe> {
  const compiler = await compile(`@theme { --spacing: 0.25rem; }\n${variants.map(variantBlock).join('\n')}\n@tailwind utilities;`);
  const css = compiler.build([...new Set(classes)]);
  const out = new Map<string, Decl[]>();
  const order: string[] = [];
  for (const rule of parseCss(css).children) {
    if (!rule.head.startsWith('.')) continue;
    const cls = rule.head.slice(1).replace(/\\(.)/g, '$1');
    order.push(cls);
    const add = (prop: string, value: string, whens: Array<(e: Env) => boolean>) =>
      out.set(cls, [...(out.get(cls) ?? []), { prop, value, when: (e) => whens.every((w) => w(e)) }]);
    const walk = (node: Node, whens: Array<(e: Env) => boolean>) => {
      for (const [prop, value] of node.decls) if (props.includes(prop)) add(prop, value, whens);
      for (const child of node.children) {
        // 읽을 속성이 없는 가지(색 · 초점 링 …)는 건너뛴다 — 그 가지의 선택자는 이 시험의 물음이 아니다.
        if (!hasProp(child, props)) continue;
        const head = child.head;
        walk(child, [...whens, (e) => nodeApplies(head, e)]);
      }
    };
    walk(rule, []);
  }
  return { classes: out, order };
}
function hasProp(node: Node, props: string[]): boolean {
  return node.decls.some(([p]) => props.includes(p)) || node.children.some((c) => hasProp(c, props));
}

/** 클래스 목록과 기기 꼴로 한 속성의 «이기는 값»(같은 속성은 CSS 나온 순서에서 뒤가 이긴다) — 없으면 null. */
export function winning(probe: Probe, classList: string, prop: string, env: Env): string | null {
  const present = classList.split(/\s+/).filter((c) => probe.classes.has(c)).sort((a, b) => probe.order.indexOf(a) - probe.order.indexOf(b));
  let value: string | null = null;
  for (const c of present) for (const d of probe.classes.get(c)!) if (d.prop === prop && d.when(env)) value = d.value;
  return value;
}
