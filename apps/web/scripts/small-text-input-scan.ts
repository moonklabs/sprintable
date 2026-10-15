/**
 * story #4406 — 모바일 폭에서 글자가 16px 미만인 입력칸을 센다(iOS WebKit은 그런 칸에 초점이 가면 화면을 확대한다).
 *
 * 판정(정적 · 모바일 기본값 = 접두사 없는 `text-*`):
 * - 날 `<input>` · `<textarea>` · `<select>`: 접두사 없는 크기 클래스가 16px 미만이면 셈. 크기 클래스가 없으면 부모에게서 물려받아
 *   정적으로 모른다 → 세지 않음(`inherits`로 따로 돌려줌).
 * - 공용 `<Input>` · `<Textarea>`: 기본이 16px(`text-base`)이라, className에 16px 미만 크기 클래스를 줄 때만(tailwind-merge가 덮음) 셈.
 * - 글자 입력이 아닌 type(checkbox · radio · file 등)은 뺀다(초점 확대 대상 아님).
 * - className 안의 문자열 조각(따옴표 · 템플릿 · cn(…) 인자)과, 같은 파일의 `const X = '…'` 문자열 상수 식별자를 읽는다.
 * - 크기 클래스가 여럿이면 마지막이 이긴다(Tailwind 같은 속성 클래스끼리의 실제 순서와는 다를 수 있으나 한 칸에 둘을 쓰는 자리는 없다).
 * - 공용 래퍼(`WRAPPERS` 표 — 입력칸을 감싼 컴포넌트)의 **호출부**도 센다: 래퍼 크기는 정의 파일을 같은 규칙으로 읽어 정하고(숫자를
 *   박지 않음), 호출부가 className으로 크기를 덮지 않으면 그 크기를 받는다. 래퍼 정의만 세면 호출부가 첫 진입 화면에 있어도
 *   «0»으로 통과한다(PR 4807 · onboarding-form의 OperatorInput 6칸).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { cn } from '../src/lib/utils';

const NON_TEXT_TYPES = new Set(['checkbox', 'radio', 'hidden', 'file', 'range', 'color', 'submit', 'button', 'image', 'reset']);
const RAW_TAGS = new Set(['input', 'textarea', 'select']);
const SHARED_TAGS = new Set(['Input', 'Textarea']);
const NAMED_SIZES: Record<string, number> = { 'text-xs': 12, 'text-sm': 14, 'text-base': 16, 'text-lg': 18, 'text-xl': 20, 'text-2xl': 24, 'text-3xl': 30 };

/** 입력칸을 감싼 공용 래퍼 → 정의 파일(src 기준). 새 래퍼를 만들면 여기에 적는다(가드의 셀프테스트가 정의가 실제로 있는지 본다). */
export const WRAPPERS: Readonly<Record<string, string>> = {
  OperatorInput: 'components/ui/operator-control.tsx',
  OperatorTextarea: 'components/ui/operator-control.tsx',
  OperatorSelect: 'components/ui/operator-control.tsx',
  // story #4410 — 자기 크기 없이 호출부 className을 그대로 받는 래퍼(«호출부가 크기 주는 래퍼»). 정의에 크기가 없어도 던지지 않고,
  // 호출부가 준 크기로 판정한다(호출부도 크기가 없으면 부모를 물려받아 정적으로 모름 → 세지 않음).
  EntityAwareTextarea: 'components/shared/entity-aware-textarea.tsx',
};

/** 크기를 호출부에게 맡기는 래퍼 — 정의에 크기가 없는 것이 정상. */
export const CALLER_SIZED_WRAPPERS: ReadonlySet<string> = new Set(['EntityAwareTextarea']);

/** 래퍼 정의에서 읽은 것 — 입력칸의 클래스 문자열(호출부와 병합할 원본)과 모바일 크기. */
export interface WrapperInfo {
  /** 래퍼가 그리는 공용 부품(예: shadcn Input)이 스스로 가진 클래스 — 래퍼 클래스 · 호출부 className이 그 뒤에 합쳐진다. 날 요소면 빈 문자열. */
  inner: string;
  classes: string;
  /** 모바일 크기 — 호출부가 크기를 주는 래퍼(CALLER_SIZED_WRAPPERS)는 null. */
  px: number | null;
}

/** 래퍼 호출부가 스스로 준 크기가 병합 뒤 데스크톱(lg 이상)에서 달라지는 자리 — 4406의 «데스크톱 무변» 약속을 깨는 것. */
export interface DesktopDrift {
  file: string;
  line: number;
  tag: string;
  intendedPx: number;
  mergedPx: number;
}

export interface SmallTextInputSite {
  file: string;
  line: number;
  tag: string;
  px: number;
}

/** 접두사 없는(모바일 기본값) 크기 클래스의 px — 없으면 null. */
export function baseFontPx(classes: string): number | null {
  let px: number | null = null;
  for (const token of classes.split(/\s+/)) {
    if (!token || token.includes(':')) continue;
    if (token in NAMED_SIZES) px = NAMED_SIZES[token]!;
    const arbitrary = /^text-\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(token);
    if (arbitrary) px = arbitrary[2] === 'rem' ? parseFloat(arbitrary[1]!) * 16 : parseFloat(arbitrary[1]!);
  }
  return px;
}

/**
 * lg 미만(폰 · 태블릿) 폭에서 실제로 쓰이는 가장 작은 크기. 구간 셋 — <640(접두사 없음) · 640~767(sm: ?? 앞) ·
 * 768~1023(md: ?? 앞) — 마다 적용되는 값을 구해 최솟값. `sm:` · `md:`는 데스크톱이 아니다(까디르 4821 · 아이패드 세로 768/820).
 * 크기가 한 구간도 없으면 null(부모를 물려받음).
 */
export function belowLgFontPx(classes: string): number | null {
  const at = (prefix: string) => baseFontPx(classes.split(/\s+/).filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length)).join(' '));
  const phone = baseFontPx(classes);
  const small = at('sm:') ?? phone;
  const medium = at('md:') ?? small;
  const bands = [phone, small, medium].filter((px): px is number => px !== null);
  return bands.length ? Math.min(...bands) : null;
}

/** lg 이상(데스크톱)에서의 크기 — `lg:` 크기 클래스가 있으면 그것(마지막이 이김), 없으면 모바일 기본값. */
export function desktopFontPx(classes: string): number | null {
  // 1024px 이상에서는 sm: · md: · lg: 모두 적용되고 Tailwind가 큰 쪽 규칙을 뒤에 싣으므로 lg → md → sm → 접두사 없음 순(sm:도 데스크톱에 적용된다).
  const at = (prefix: string) => baseFontPx(classes.split(/\s+/).filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length)).join(' '));
  return at('lg:') ?? at('md:') ?? at('sm:') ?? baseFontPx(classes);
}

/** 래퍼를 반응형으로 바꾸기 전 모양 — 접두사 없는 크기를 빼고 `lg:` 크기를 접두사 없이 편다(`text-base lg:text-sm` → `text-sm`). */
export function beforeResponsive(classes: string): string {
  const tokens = classes.split(/\s+/).filter(Boolean);
  const lgSizes = tokens.filter((t) => t.startsWith('lg:') && baseFontPx(t.slice(3)) !== null).map((t) => t.slice(3));
  if (!lgSizes.length) return classes;
  return [...tokens.filter((t) => baseFontPx(t) === null && !(t.startsWith('lg:') && baseFontPx(t.slice(3)) !== null)), ...lgSizes].join(' ');
}

function stringConstants(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
      out.set(node.name.text, node.initializer.text);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function classText(expr: ts.Node, constants: Map<string, string>): string {
  const parts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) parts.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      parts.push(node.head.text);
      for (const span of node.templateSpans) { visit(span.expression); parts.push(span.literal.text); }
      return;
    } else if (ts.isIdentifier(node) && constants.has(node.text)) parts.push(constants.get(node.text)!);
    // 삼항 · 논리식 안의 문자열은 상태에 따라 붙는 색 · 테두리 클래스라 크기 판정에서 뺀다(크기는 한 자리에 고정으로 쓴다).
    if (ts.isConditionalExpression(node) || ts.isBinaryExpression(node)) return;
    node.forEachChild(visit);
  };
  visit(expr);
  return parts.join(' ');
}

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

export function scanSource(
  content: string,
  file: string,
  wrappers: ReadonlyMap<string, WrapperInfo> = new Map(),
): { sites: SmallTextInputSite[]; inherits: number; drift: DesktopDrift[] } {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = stringConstants(sf);
  const sites: SmallTextInputSite[] = [];
  const drift: DesktopDrift[] = [];
  let inherits = 0;
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const wrapper = wrappers.get(tag);
      if (wrapper !== undefined) {
        // 최종 클래스 = 공용 부품 자기 클래스 ← 래퍼 클래스 ← 호출부 className 순서로 cn()(tailwind-merge) 병합. tailwind-merge는 같은
        // 수식자끼리만 지우므로 호출부 `text-xs`는 `text-base`만 지우고 `md:text-sm`(shadcn Input) · `lg:text-sm`(래퍼)은 남긴다
        // (유나 4807 실측 두 번). 그래서 세 겹을 실제로 합친 값으로 잰다.
        const init = attr(node, 'className')?.initializer;
        const own = init ? classText(init, constants) : '';
        const final = cn(wrapper.inner, cn(wrapper.classes, own));
        const px = belowLgFontPx(final) ?? wrapper.px;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (px !== null && px < 16) sites.push({ file, line, tag, px });
        // 데스크톱 무변: 래퍼를 반응형으로 바꾸기 전 모양(같은 호출부)과 데스크톱 크기가 같아야 한다.
        const before = desktopFontPx(cn(wrapper.inner, cn(beforeResponsive(wrapper.classes), own)));
        const after = desktopFontPx(final);
        if (before !== null && after !== null && before !== after) drift.push({ file, line, tag, intendedPx: before, mergedPx: after });
      } else if (RAW_TAGS.has(tag) || SHARED_TAGS.has(tag)) {
        const type = attr(node, 'type')?.initializer;
        const typeText = type && ts.isStringLiteral(type) ? type.text : null;
        if (!(typeText && NON_TEXT_TYPES.has(typeText))) {
          const init = attr(node, 'className')?.initializer;
          const classes = init ? classText(init, constants) : '';
          const px = belowLgFontPx(classes);
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          if (px !== null && px < 16) sites.push({ file, line, tag, px });
          else if (px === null && RAW_TAGS.has(tag)) inherits += 1;
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return { sites, inherits, drift };
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith('.tsx') && !/\.test\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * 래퍼 이름 → 모바일 글자 크기(px). 정의 파일에서 그 이름의 함수가 그리는 입력칸 하나의 크기를 같은 규칙으로 읽는다
 * (날 칸이면 접두사 없는 크기 · 공용 Input/Textarea면 준 크기 없을 때 16). 정의나 입력칸을 못 찾으면 던진다(표가 헛돌지 않게).
 */
/** 공용 부품 → 정의 파일. 그 부품이 스스로 가진 className(첫 JSX 요소의 cn 첫 문자열들)을 읽는다. */
export const SHARED_DEFS: Readonly<Record<string, string>> = {
  Input: 'components/ui/input.tsx',
};

function componentClasses(content: string, rel: string, name: string): string {
  const sf = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = stringConstants(sf);
  let body: ts.Node | undefined;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) body = n;
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) body = d;
  });
  if (!body) throw new Error(`공용 부품 ${name}의 정의가 ${rel}에 없다 — SHARED_DEFS 표를 고칠 것`);
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if (found !== undefined) return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const init = attr(node, 'className')?.initializer;
      if (init) { found = classText(init, constants); return; }
    }
    node.forEachChild(visit);
  };
  visit(body);
  if (found === undefined) throw new Error(`공용 부품 ${name}(${rel})에 className이 없다 — SHARED_DEFS 표를 고칠 것`);
  return found;
}

export function wrapperSizes(contentOf: (rel: string) => string): Map<string, WrapperInfo> {
  const out = new Map<string, WrapperInfo>();
  const sharedCache = new Map<string, string>();
  const sharedBase = (tag: string): string => {
    const rel = SHARED_DEFS[tag];
    if (!rel) return '';
    if (!sharedCache.has(tag)) sharedCache.set(tag, componentClasses(contentOf(rel), rel, tag));
    return sharedCache.get(tag)!;
  };
  for (const [name, rel] of Object.entries(WRAPPERS)) {
    const content = contentOf(rel);
    const sf = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const constants = stringConstants(sf);
    let body: ts.Node | undefined;
    sf.forEachChild((n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === name) body = n;
      if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) body = d;
    });
    if (!body) throw new Error(`래퍼 ${name}의 정의가 ${rel}에 없다 — WRAPPERS 표를 고칠 것`);
    let px: number | null | undefined;
    let classes = '';
    let inner = '';
    const visit = (node: ts.Node) => {
      if (px !== undefined) return;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        if (RAW_TAGS.has(tag) || SHARED_TAGS.has(tag)) {
          const init = attr(node, 'className')?.initializer;
          classes = init ? classText(init, constants) : '';
          inner = SHARED_TAGS.has(tag) ? sharedBase(tag) : '';
          px = belowLgFontPx(cn(inner, classes)) ?? null;
          return;
        }
      }
      node.forEachChild(visit);
    };
    visit(body);
    if (px === undefined) throw new Error(`래퍼 ${name}(${rel})가 입력칸을 그리지 않는다 — WRAPPERS 표를 고칠 것`);
    if (px === null && !CALLER_SIZED_WRAPPERS.has(name)) throw new Error(`래퍼 ${name}(${rel})의 글자 크기를 정적으로 못 정한다(부모를 물려받음) — 래퍼에 크기를 줄 것`);
    out.set(name, { inner, classes, px });
  }
  return out;
}

/**
 * story #4410(PO 01:11Z) — 래퍼를 손 목록으로만 두면 다음 래퍼가 샌다(MenuSearchInput이 `{...props}`로 className을 넘겨 보드 검색칸
 * 다섯이 가드 밖이었다). 트리에서 **입력칸을 그리며 호출부 className을 넘기는 컴포넌트**를 찾아 래퍼로 삼는다:
 * PascalCase 컴포넌트가 처음 그리는 입력칸(날 · 공용)의 className 식이 `className`을 참조하거나, className 속성이 없거나 그 뒤에
 * 펼침(`{...props}`)이 있으면(= 호출부 className이 이김) 넘기는 것으로 본다. 크기는 정의를 같은 규칙으로 읽는다(공용 부품이면 밑단까지 병합 ·
 * 크기가 없으면 호출부가 크기를 주는 래퍼 = null). 같은 이름이 두 파일에서 다르게 나오면 던진다(호출부가 어느 쪽인지 모름).
 */
export function discoverWrappers(contents: ReadonlyMap<string, string>, sharedBase: (tag: string) => string): Map<string, WrapperInfo & { file: string }> {
  const out = new Map<string, WrapperInfo & { file: string }>();
  for (const [rel, content] of contents) {
    if (!/<(input|textarea|select|Input|Textarea)\b/.test(content)) continue;
    const sf = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const constants = stringConstants(sf);
    const consider = (name: string, body: ts.Node) => {
      if (!/^[A-Z]/.test(name) || RAW_TAGS.has(name) || SHARED_TAGS.has(name)) return;
      let el: ts.JsxOpeningLikeElement | undefined;
      const find = (n: ts.Node) => {
        if (el) return;
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && (RAW_TAGS.has(n.tagName.getText(sf)) || SHARED_TAGS.has(n.tagName.getText(sf)))) { el = n; return; }
        n.forEachChild(find);
      };
      find(body);
      if (!el) return;
      const props = el.attributes.properties;
      const clsIdx = props.findIndex((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'className');
      const spreadAfter = props.some((p, i) => ts.isJsxSpreadAttribute(p) && i > clsIdx);
      const clsAttr = clsIdx >= 0 ? (props[clsIdx] as ts.JsxAttribute) : undefined;
      const refersClassName = !!clsAttr?.initializer && /\bclassName\b/.test(clsAttr.initializer.getText(sf));
      if (!(refersClassName || spreadAfter)) return;
      const tag = el.tagName.getText(sf);
      const classes = clsAttr?.initializer ? classText(clsAttr.initializer, constants) : '';
      const inner = SHARED_TAGS.has(tag) ? sharedBase(tag) : '';
      const px = belowLgFontPx(cn(inner, classes)) ?? (SHARED_TAGS.has(tag) ? 16 : null);
      const info = { inner, classes, px, file: rel };
      const prev = out.get(name);
      if (prev && (prev.classes !== classes || prev.inner !== inner)) {
        throw new Error(`래퍼 이름 ${name}이 두 파일에서 다르게 나온다(${prev.file} · ${rel}) — 호출부가 어느 쪽인지 정적으로 못 가린다. 이름을 나누거나 가드를 넓힐 것`);
      }
      out.set(name, info);
    };
    sf.forEachChild((n) => {
      if (ts.isFunctionDeclaration(n) && n.name) consider(n.name.text, n);
      if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) consider(d.name.text, d.initializer);
    });
  }
  return out;
}

/** 파일별 16px 미만 칸 수(0인 파일은 뺌) · 전체 목록 · 래퍼 크기. */
export function scanTree(srcRoot: string): {
  perFile: Record<string, number>;
  sites: SmallTextInputSite[];
  fileCount: number;
  wrappers: Map<string, WrapperInfo>;
  drift: DesktopDrift[];
} {
  const files = tsxFiles(srcRoot);
  const contents = new Map<string, string>();
  for (const abs of files) contents.set(path.relative(srcRoot, abs).split(path.sep).join('/'), readFileSync(abs, 'utf8'));
  const contentOf = (rel: string) => {
    const c = contents.get(rel);
    if (c === undefined) throw new Error(`래퍼 정의 파일 ${rel}이 트리에 없다 — WRAPPERS 표를 고칠 것`);
    return c;
  };
  // 손 목록(WRAPPERS)은 «반드시 있어야 하는» 씨앗(정의가 사라지면 던짐) · 그 밖은 트리에서 찾은 래퍼.
  const wrappers: Map<string, WrapperInfo> = wrapperSizes(contentOf);
  const sharedCache = new Map<string, string>();
  for (const [name, info] of discoverWrappers(contents, (tag) => {
    const rel = SHARED_DEFS[tag];
    if (!rel) return '';
    if (!sharedCache.has(tag)) sharedCache.set(tag, componentClasses(contentOf(rel), rel, tag));
    return sharedCache.get(tag)!;
  })) {
    if (!wrappers.has(name)) wrappers.set(name, { inner: info.inner, classes: info.classes, px: info.px });
  }
  const tagPattern = new RegExp(`<(input|textarea|select|Input|Textarea|${[...wrappers.keys()].join('|')})\\b`);
  const perFile: Record<string, number> = {};
  const sites: SmallTextInputSite[] = [];
  const drift: DesktopDrift[] = [];
  for (const [rel, content] of contents) {
    if (!tagPattern.test(content)) continue;
    const found = scanSource(content, rel, wrappers);
    if (found.sites.length) { perFile[rel] = found.sites.length; sites.push(...found.sites); }
    drift.push(...found.drift);
  }
  return { perFile, sites, fileCount: files.length, wrappers, drift };
}
