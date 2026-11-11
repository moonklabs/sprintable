// @vitest-environment jsdom
// UI-3(a9d56577) `touch:` 변형 회귀가드 — 44 바닥이 «손가락 기기»에서 실제로 걸리는가.
// jsdom은 미디어 쿼리를 안 돌린다 → ds 부품이 실제로 쓰는 클래스를 Tailwind로 «컴파일»하고(변형 정의는 design-system.css 소스에서 그대로 꺼낸다),
// 컴파일된 CSS를 기기 꼴별로 읽어 누름 높이(height · min-height)를 계산한다. 변형 정의를 되돌리거나 부품이 다시 pointer-coarse만 쓰면 빨개진다.
import { beforeAll, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from 'tailwindcss';
import { Button } from './button';
import { Input } from './input';
import { NativeSelect } from './select';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── 변형 정의를 CSS 소스에서 그대로 꺼낸다 ─────────────────────────────────────
const CSS_SOURCE = readFileSync(resolve(__dirname, '../../styles/design-system.css'), 'utf-8');
function variantBlock(): string {
  const start = CSS_SOURCE.indexOf('@custom-variant touch');
  expect(start, 'design-system.css에 @custom-variant touch가 있어야 한다').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS_SOURCE.indexOf('{', start); i < CSS_SOURCE.length; i++) {
    if (CSS_SOURCE[i] === '{') depth++;
    if (CSS_SOURCE[i] === '}' && --depth === 0) return CSS_SOURCE.slice(start, i + 1);
  }
  throw new Error('@custom-variant touch 블록이 닫히지 않음');
}

// ─── 컴파일된 CSS 읽개 (Tailwind가 내는 중첩 CSS 모양만 안다 — 모르는 모양이면 던진다) ──────
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

type Env = { pointer: 'fine' | 'coarse'; hover: 'hover' | 'none'; shell?: string | null };

function mediaApplies(params: string, env: Env): boolean {
  // "(pointer: coarse), (hover: none)" — 쉼표 = 또는. 이 시험이 아는 특성만(pointer · hover).
  return params.split(',').some((term) => {
    const m = /^\s*\((pointer|hover)\s*:\s*([a-z]+)\)\s*$/.exec(term);
    if (!m) throw new Error(`시험이 모르는 미디어 쿼리: ${term}`);
    return env[m[1] as 'pointer' | 'hover'] === m[2];
  });
}
function whereApplies(selector: string, env: Env): boolean {
  // "&:where([data-sprintable-shell="ios"] *, [data-sprintable-shell="android"] *)" — 조상 속성 또는
  const m = /^&:where\((.*)\)$/.exec(selector);
  if (!m) throw new Error(`시험이 모르는 선택자: ${selector}`);
  return m[1]!.split(',').some((part) => {
    const a = /^\s*\[data-sprintable-shell="([a-z]+)"\]\s*\*\s*$/.exec(part);
    if (!a) throw new Error(`시험이 모르는 조상 선택자: ${part}`);
    return env.shell === a[1];
  });
}

type Decl = { prop: string; value: string; env: (e: Env) => boolean };
function indexByClass(css: string): Map<string, Decl[]> {
  const out = new Map<string, Decl[]>();
  const add = (cls: string, d: Decl) => out.set(cls, [...(out.get(cls) ?? []), d]);
  for (const rule of parseCss(css).children) {
    if (!rule.head.startsWith('.')) continue; // :root 등
    const cls = rule.head.slice(1).replace(/\\(.)/g, '$1');
    // 누름 높이(height · min-height)만 읽는다 — 색 · 초점 같은 다른 속성의 상태 선택자(:hover · :focus-visible …)는 이 시험의 물음이 아니다.
    const isHeight = ([prop]: [string, string]) => prop === 'height' || prop === 'min-height';
    for (const [prop, value] of rule.decls.filter(isHeight)) add(cls, { prop, value, env: () => true });
    for (const child of rule.children) {
      const decls = child.decls.filter(isHeight);
      if (decls.length === 0) continue;
      if (child.head.startsWith('@media')) {
        const params = child.head.slice('@media'.length);
        for (const [prop, value] of decls) add(cls, { prop, value, env: (e) => mediaApplies(params, e) });
      } else {
        for (const [prop, value] of decls) add(cls, { prop, value, env: (e) => whereApplies(child.head, e) });
      }
    }
  }
  return out;
}

const SPACING_PX = 4; // @theme { --spacing: 0.25rem }
function px(value: string): number {
  const m = /^calc\(var\(--spacing\)\s*\*\s*(\d+(?:\.\d+)?)\)$/.exec(value);
  if (!m) throw new Error(`시험이 모르는 값: ${value}`);
  return Number(m[1]) * SPACING_PX;
}

/** 클래스 목록과 기기 꼴로 누름 높이 = max(height, min-height). 같은 속성은 CSS 나온 순서에서 뒤가 이긴다(전부 단일 클래스 힘). */
function pressHeight(classes: string, index: Map<string, Decl[]>, env: Env): number {
  const win: Record<string, string> = {};
  const order = [...index.keys()];
  const present = classes.split(/\s+/).filter((c) => index.has(c)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const c of present) for (const d of index.get(c)!) if (d.env(env) && (d.prop === 'height' || d.prop === 'min-height')) win[d.prop] = d.value;
  return Math.max(win.height ? px(win.height) : 0, win['min-height'] ? px(win['min-height']) : 0);
}

// ─── ds 부품이 실제로 내는 클래스 ──────────────────────────────────────────────
let index: Map<string, Decl[]>;
let parts: Record<string, string>;
beforeAll(async () => {
  // 부품 클래스를 먼저 모은 뒤 한 번에 컴파일한다.
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  const grab = async (node: ReactNode, selector: string) => {
    await act(async () => { r.render(node); });
    return (host.querySelector(selector) as HTMLElement).className;
  };
  parts = {
    'Button(md)': await grab(<Button>확인</Button>, '[data-slot="ds-button"]'),
    'Button(lg)': await grab(<Button size="lg">확인</Button>, '[data-slot="ds-button"]'),
    Input: await grab(<Input aria-label="이름" />, '[data-slot="ds-input"]'),
    NativeSelect: await grab(<NativeSelect aria-label="역할"><option>x</option></NativeSelect>, 'select'),
  };
  await act(async () => { r.unmount(); });
  host.remove();
  const all = new Set(Object.values(parts).flatMap((c) => c.split(/\s+/)));
  const compiler = await compile(`@theme { --spacing: 0.25rem; }\n${variantBlock()}\n@tailwind utilities;`);
  index = indexByClass(compiler.build([...all]));
});

const DESKTOP: Env = { pointer: 'fine', hover: 'hover' }; // 데스크톱 마우스
const EMULATOR: Env = { pointer: 'fine', hover: 'none' }; // 안드로이드 에뮬 웹뷰 · S펜류 — 민군 실측 꼴
const PHONE: Env = { pointer: 'coarse', hover: 'none' }; // 보통 폰 · 태블릿(iOS)
const TABLET_PEN: Env = { pointer: 'coarse', hover: 'hover' }; // coarse만 참인 꼴
const APP_ANDROID: Env = { pointer: 'fine', hover: 'hover', shell: 'android' }; // 스타일러스 폰이 앱 안에서 마우스로 읽히는 꼴 — 앱 셸 표지가 건다
const APP_IOS: Env = { pointer: 'fine', hover: 'hover', shell: 'ios' };
const APP_MAC: Env = { pointer: 'fine', hover: 'hover', shell: 'macos' }; // 맥 데스크톱 앱 = 마우스 → 36

describe('touch: 변형 — 44 바닥', () => {
  it('⭐데스크톱(fine + hover)은 그대로: Button 28/36 · Input 36 · NativeSelect 36', () => {
    expect(pressHeight(parts['Button(md)']!, index, DESKTOP)).toBe(28);
    expect(pressHeight(parts['Button(lg)']!, index, DESKTOP)).toBe(36);
    expect(pressHeight(parts.Input!, index, DESKTOP)).toBe(36);
    expect(pressHeight(parts.NativeSelect!, index, DESKTOP)).toBe(36);
  });

  it('⭐에뮬 꼴(fine + hover none)에서도 44 — pointer-coarse만 쓰던 때 빠지던 자리', () => {
    for (const [name, cls] of Object.entries(parts)) expect(pressHeight(cls, index, EMULATOR), name).toBe(44);
  });

  it('⭐보통 폰(coarse + hover none)과 coarse만 참인 꼴도 44', () => {
    for (const env of [PHONE, TABLET_PEN]) for (const [name, cls] of Object.entries(parts)) expect(pressHeight(cls, index, env), name).toBe(44);
  });

  it('⭐앱 셸 안(ios · android)은 기기 분류가 «마우스»여도 44, 맥 앱(macos)은 36 그대로', () => {
    for (const env of [APP_ANDROID, APP_IOS]) for (const [name, cls] of Object.entries(parts)) expect(pressHeight(cls, index, env), name).toBe(44);
    expect(pressHeight(parts.Input!, index, APP_MAC)).toBe(36);
    expect(pressHeight(parts.NativeSelect!, index, APP_MAC)).toBe(36);
    expect(pressHeight(parts['Button(md)']!, index, APP_MAC)).toBe(28);
  });

  it('ds 부품은 pointer-coarse:를 더 쓰지 않는다(쓰면 에뮬 꼴에서 44가 빠진다)', () => {
    for (const [name, cls] of Object.entries(parts)) expect(cls, name).not.toContain('pointer-coarse:');
  });

  it('변형 정의: media 둘 «또는» — pointer: coarse · hover: none', () => {
    const b = variantBlock();
    expect(b).toContain('(pointer: coarse)');
    expect(b).toContain('(hover: none)');
  });
});
