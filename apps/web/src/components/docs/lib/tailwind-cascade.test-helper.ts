/**
 * story #4316 — 테스트 전용: 렌더된 DOM 한 요소의 «계산된» 색 · 밑줄 · 글자 크기를, 실제 Tailwind 컴파일 CSS로 가린다.
 *
 * jsdom의 getComputedStyle은 `var()`를 풀지 않아(색 = 기본 검정 · 크기 = medium) 색 · 크기 판정에 못 쓴다. 그래서:
 * 1. `src/app/globals.css`를 `@tailwindcss/node`로 컴파일(DOM에 나온 클래스 전부 + 뿌리 클래스) · 중첩 평탄화(optimize).
 * 2. jsdom CSSOM으로 규칙을 모으고(@layer · @media · @supports 안까지), `element.matches`로 맞는 규칙을 고른다.
 * 3. 이긴 선언 = (중요도 · 캐스케이드 레이어 순서 · 특이도 · 소스 순서) — CSS Cascade 5 순서 그대로.
 * 4. `var()`는 그 요소 자리에서 사용자 정의 속성을 같은 캐스케이드로 풀고(상속 포함), 테마는 `<html class="dark">` 유무로 가른다.
 * 5. 밑줄은 조상의 밑줄이 자손 글자에 그려지는(전파) 규칙대로 — 자손의 `no-underline`은 조상 밑줄을 못 지운다.
 * 이 파일은 테스트만 부른다(번들 밖).
 */
import { compile, optimize } from '@tailwindcss/node';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type Rule = { selector: string; decls: Map<string, { value: string; important: boolean }>; layer: number; order: number };

const LAYER_UNLAYERED = Number.MAX_SAFE_INTEGER;

/** CSS 선택자 하나(콤마 없는 복합 선택자)의 특이도 [a, b, c] — :where()=0 · :is/:not/:has=인자 중 최대 · 이스케이프 처리. */
export function specificity(selector: string): [number, number, number] {
  let a = 0; let b = 0; let c = 0;
  let i = 0;
  const readIdent = () => { const start = i; while (i < selector.length) { const ch = selector[i]!; if (ch === '\\') { i += 2; continue; } if (/[\w-]/.test(ch) || ch.charCodeAt(0) > 127) { i++; continue; } break; } return selector.slice(start, i); };
  const readParens = () => { let depth = 0; const start = i; for (; i < selector.length; i++) { const ch = selector[i]!; if (ch === '\\') { i++; continue; } if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth === 0) { i++; break; } } } return selector.slice(start + 1, i - 1); };
  const splitList = (s: string) => { const out: string[] = []; let depth = 0; let cur = ''; for (let k = 0; k < s.length; k++) { const ch = s[k]!; if (ch === '\\') { cur += ch + (s[k + 1] ?? ''); k++; continue; } if (ch === '(' || ch === '[') depth++; if (ch === ')' || ch === ']') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()).filter(Boolean); };
  const maxOf = (list: string) => splitList(list).map(specificity).reduce<[number, number, number]>((m, s) => (cmp(s, m) > 0 ? s : m), [0, 0, 0]);
  while (i < selector.length) {
    const ch = selector[i]!;
    if (ch === '#') { i++; readIdent(); a++; }
    else if (ch === '.') { i++; readIdent(); b++; }
    else if (ch === '[') { let depth = 0; for (; i < selector.length; i++) { const x = selector[i]!; if (x === '\\') { i++; continue; } if (x === '[') depth++; else if (x === ']') { depth--; if (depth === 0) { i++; break; } } } b++; }
    else if (ch === ':') {
      if (selector[i + 1] === ':') { i += 2; readIdent(); if (selector[i] === '(') readParens(); c++; continue; }
      i++; const name = readIdent().toLowerCase();
      if (selector[i] === '(') {
        const arg = readParens();
        if (name === 'where') continue;
        if (name === 'is' || name === 'not' || name === 'has' || name === 'matches') { const s = maxOf(arg); a += s[0]; b += s[1]; c += s[2]; continue; }
        b++; continue;
      }
      if (['before', 'after', 'first-line', 'first-letter'].includes(name)) c++; else b++;
    }
    else if (ch === '*') { i++; }
    else if (/[a-zA-Z]/.test(ch)) { readIdent(); c++; }
    else i++;
  }
  return [a, b, c];
}
/** Tailwind가 클래스 선택자를 적는 방식 그대로 이스케이프(식별자 밖 글자 앞에 역슬래시 · 맨 앞 숫자는 코드포인트). */
export function cssEscapeClass(cls: string): string {
  return cls.replace(/^(\d)/, (d) => `\\3${d} `).replace(/[^a-zA-Z0-9_\-\u0080-\uFFFF]/g, (ch) => `\\${ch}`);
}
function cmp(x: [number, number, number], y: [number, number, number]): number { return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }
function splitSelectorList(s: string): string[] {
  const out: string[] = []; let depth = 0; let cur = '';
  for (let k = 0; k < s.length; k++) { const ch = s[k]!; if (ch === '\\') { cur += ch + (s[k + 1] ?? ''); k++; continue; } if (ch === '(' || ch === '[') depth++; if (ch === ')' || ch === ']') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return out.map((x) => x.trim()).filter(Boolean);
}

export interface Cascade {
  /** 요소의 계산된 값(색 · 크기는 상속 · var 해석 끝 · 밑줄은 전파 반영). theme = html.dark 유무. */
  computed(el: Element, prop: 'color' | 'font-size' | 'line-height' | 'text-decoration-line', theme: 'light' | 'dark'): string;
  /** 요소 «자기 클래스»만으로 선언된 값(그 클래스 단독 규칙 · var 해석) — 없으면 null. */
  declared(el: Element, prop: 'color' | 'font-size' | 'line-height' | 'text-decoration-line', theme: 'light' | 'dark'): string | null;
  /** 요소에 이긴 선언의 선택자(표의 «이기는 규칙» 칸). */
  winner(el: Element, prop: string): string | null;
  /** jsdom이 못 읽은 선택자(0이어야 판정을 믿을 수 있다). */
  unparsable(): string[];
}

/** 이스케이프가 든 클래스 선택자 조각을 별칭 클래스로(매칭 전용 · 별칭은 loadTailwindCascade가 같은 요소에 붙인다). */
export function toMatchable(selector: string, alias: ReadonlyMap<string, string>): string {
  return selector.replace(/\.((?:\\[0-9a-fA-F]{1,6}\s|\\.|[\w-]|[^\x00-\x7F])+)/g, (whole, body: string) => {
    if (!body.includes('\\')) return whole;
    const cls = body.replace(/\\([0-9a-fA-F]{1,6})\s/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, '$1');
    return `.${alias.get(cls) ?? 'twc-no-such-class'}`;
  });
}

/** container 안(과 뿌리 클래스)에 나온 클래스로 CSS를 컴파일해 문서에 싣고 해석기를 돌려준다. */
export async function loadTailwindCascade(container: Element): Promise<Cascade> {
  // 파일 기준 경로 — CI vitest는 레포 뿌리에서 돌아 cwd에 `apps/web`이 빠진다(4681 CI RED).
  const base = path.resolve(__dirname, '../../../app');
  const compiler = await compile(readFileSync(path.join(base, 'globals.css'), 'utf8'), { base, onDependency: () => {} });
  const candidates = new Set<string>();
  for (const el of [container, ...container.querySelectorAll('*')]) for (const cls of (el.getAttribute('class') ?? '').split(/\s+/)) if (cls) candidates.add(cls);
  const raw = compiler.build([...candidates]);
  // jsdom 선택자 엔진(nwsapi)은 `[`·`&`·`:` 같은 글자가 든 클래스를 이스케이프로도 · 속성 선택자로도 못 읽는다. 그런 클래스마다 안전한 별칭 클래스를
  // 같은 요소에 붙여 두고 매칭은 별칭으로 한다(CSS는 이미 원래 클래스로 컴파일됨 · 별칭은 규칙이 없어 캐스케이드에 영향 0).
  const alias = new Map<string, string>();
  for (const cls of candidates) if (/[^\w-]/.test(cls)) alias.set(cls, `twc-${alias.size}`);
  for (const el of [container, ...container.querySelectorAll('*')]) for (const cls of [...el.classList]) { const a = alias.get(cls); if (a) el.classList.add(a); }
  const flat = (optimize as unknown as (css: string, o?: object) => { code: string })(raw, { minify: false }).code;
  // 레이어 순서 선언(`@layer a, b;`)을 먼저 읽어 순위를 매긴다(블록 순서와 같다).
  const layerOrder: string[] = [];
  for (const m of flat.matchAll(/@layer\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s*;/g)) for (const n of m[1]!.split(',')) { const k = n.trim(); if (!layerOrder.includes(k)) layerOrder.push(k); }
  const style = document.createElement('style');
  style.setAttribute('data-tailwind-cascade', '');
  style.textContent = flat.replace(/@layer\s+[\w-]+(\s*,\s*[\w-]+)*\s*;/g, '');
  document.head.querySelectorAll('style[data-tailwind-cascade]').forEach((s) => s.remove());
  document.head.appendChild(style);

  const rules: Rule[] = [];
  const unparsable = new Set<string>();
  let order = 0;
  const walk = (list: CSSRuleList, layer: number) => {
    for (const r of [...(list as unknown as CSSRule[])]) {
      const kind = r.constructor.name;
      if (kind === 'CSSLayerBlockRule') {
        const name = (r as unknown as { name: string }).name;
        if (!layerOrder.includes(name)) layerOrder.push(name);
        walk((r as unknown as { cssRules: CSSRuleList }).cssRules, layerOrder.indexOf(name));
      } else if (kind === 'CSSMediaRule') {
        const media = (r as CSSMediaRule).conditionText ?? (r as CSSMediaRule).media.mediaText;
        // 데스크톱 화면 가정: 폭 하한(min-width) · hover · 일반 조건은 맞음 · prefers-* · print · max-width는 뺀다.
        if (/prefers-|print|max-width|forced-colors/.test(media)) continue;
        walk((r as CSSMediaRule).cssRules, layer);
      } else if (kind === 'CSSSupportsRule') {
        walk((r as CSSSupportsRule).cssRules, layer);
      } else if (kind === 'CSSStyleRule') {
        const sr = r as CSSStyleRule;
        const decls = new Map<string, { value: string; important: boolean }>();
        for (let k = 0; k < sr.style.length; k++) { const p = sr.style.item(k); decls.set(p, { value: sr.style.getPropertyValue(p).trim(), important: sr.style.getPropertyPriority(p) === 'important' }); }
        rules.push({ selector: sr.selectorText, decls, layer, order: order++ });
      }
    }
  };
  walk(document.styleSheets[document.styleSheets.length - 1]!.cssRules, LAYER_UNLAYERED);

  const matchSpec = (el: Element, selector: string): [number, number, number] | null => {
    let best: [number, number, number] | null = null;
    for (const s of splitSelectorList(selector)) {
      let ok = false;
      // jsdom 선택자 엔진은 Tailwind의 이스케이프 클래스(`.\\[\\&_p\\]\\:text-foreground`)를 못 읽는다 — 매칭에만 같은 뜻의
      // `[class~="…"]`(특이도도 같은 0,1,0)로 바꿔 물어본다(특이도는 원래 선택자로 잰다). 못 읽는 선택자는 조용히 «안 맞음»으로 두지 않고 모은다.
      try { ok = el.matches(toMatchable(s, alias)); } catch { unparsable.add(s); ok = false; }
      if (ok) { const sp = specificity(s); if (!best || cmp(sp, best) > 0) best = sp; }
    }
    return best;
  };
  const cascadeWinner = (el: Element, prop: string, onlyRules?: (r: Rule) => boolean) => {
    let best: { rule: Rule; spec: [number, number, number]; important: boolean } | null = null;
    for (const rule of rules) {
      const d = rule.decls.get(prop);
      if (!d) continue;
      if (onlyRules && !onlyRules(rule)) continue;
      const spec = matchSpec(el, rule.selector);
      if (!spec) continue;
      if (!best) { best = { rule, spec, important: d.important }; continue; }
      // CSS Cascade 5: 중요도 → 레이어(보통 선언은 뒤 레이어 · 레이어 밖이 이김 / !important는 반대) → 특이도 → 순서.
      if (d.important !== best.important) { if (d.important) best = { rule, spec, important: true }; continue; }
      const layerCmp = d.important ? best.rule.layer - rule.layer : rule.layer - best.rule.layer;
      if (layerCmp !== 0) { if (layerCmp > 0) best = { rule, spec, important: d.important }; continue; }
      const sc = cmp(spec, best.spec);
      if (sc > 0 || (sc === 0 && rule.order > best.rule.order)) best = { rule, spec, important: d.important };
    }
    return best ? { value: best.rule.decls.get(prop)!.value, selector: best.rule.selector } : null;
  };
  const withTheme = <T,>(theme: 'light' | 'dark', fn: () => T): T => {
    const html = document.documentElement;
    const had = html.classList.contains('dark');
    html.classList.toggle('dark', theme === 'dark');
    try { return fn(); } finally { html.classList.toggle('dark', had); }
  };
  const customProp = (el: Element | null, name: string): string | null => {
    for (let cur = el; cur; cur = cur.parentElement) { const w = cascadeWinner(cur, name); if (w) return w.value; }
    return null;
  };
  const resolveVars = (el: Element, value: string, depth = 0): string => {
    if (depth > 20) return value;
    return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_m, name: string, fallback?: string) => {
      const v = customProp(el, name);
      return v != null ? resolveVars(el, v, depth + 1) : (fallback != null ? resolveVars(el, fallback.trim(), depth + 1) : `var(${name})`);
    });
  };
  const INHERITED = new Set(['color', 'font-size', 'line-height']);
  const computedRaw = (el: Element, prop: string): string => {
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      const w = cascadeWinner(cur, prop);
      if (w && w.value !== 'inherit' && w.value !== 'currentcolor' && w.value !== 'currentColor') return resolveVars(cur, w.value);
      if (!INHERITED.has(prop)) return 'none';
    }
    return prop === 'font-size' ? 'medium' : prop === 'line-height' ? 'normal' : 'canvastext';
  };

  return {
    computed(el, prop, theme) {
      return withTheme(theme, () => {
        if (prop === 'text-decoration-line') {
          // 전파: 자기 또는 조상(뿌리 컨테이너까지) 어느 하나라도 underline이면 이 글자에 밑줄이 그려진다.
          for (let cur: Element | null = el; cur && cur !== container.parentElement; cur = cur.parentElement) {
            const w = cascadeWinner(cur, 'text-decoration-line');
            if (w && /underline/.test(resolveVars(cur, w.value))) return 'underline';
          }
          return 'none';
        }
        return computedRaw(el, prop);
      });
    },
    declared(el, prop, theme) {
      return withTheme(theme, () => {
        const own = new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).map((c) => `.${cssEscapeClass(c)}`));
        const w = cascadeWinner(el, prop, (r) => splitSelectorList(r.selector).some((s) => own.has(s)));
        return w ? resolveVars(el, w.value) : null;
      });
    },
    winner(el, prop) {
      const w = cascadeWinner(el, prop);
      return w?.selector ?? null;
    },
    unparsable: () => [...unparsable],
  };
}
