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
};

/** 래퍼 정의에서 읽은 것 — 입력칸의 클래스 문자열(호출부와 병합할 원본)과 모바일 크기. */
export interface WrapperInfo {
  classes: string;
  px: number;
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

/** lg 이상(데스크톱)에서의 크기 — `lg:` 크기 클래스가 있으면 그것(마지막이 이김), 없으면 모바일 기본값. */
export function desktopFontPx(classes: string): number | null {
  const lg = classes.split(/\s+/).filter((t) => t.startsWith('lg:')).map((t) => t.slice(3)).join(' ');
  return baseFontPx(lg) ?? baseFontPx(classes);
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
        // 호출부 className은 래퍼 안에서 cn()(tailwind-merge)으로 래퍼 클래스 뒤에 합쳐진다 — 같은 수식자끼리만 지우므로
        // 호출부 `text-xs`는 래퍼 `text-base`만 지우고 `lg:text-sm`은 남긴다(유나 4807 실측). 그래서 최종 병합 결과로 판정한다.
        const init = attr(node, 'className')?.initializer;
        const own = init ? classText(init, constants) : '';
        const merged = cn(wrapper.classes, own);
        const px = baseFontPx(merged) ?? wrapper.px;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (px < 16) sites.push({ file, line, tag, px });
        const intendedPx = desktopFontPx(own);
        const mergedPx = desktopFontPx(merged) ?? px;
        if (intendedPx !== null && intendedPx !== mergedPx) drift.push({ file, line, tag, intendedPx, mergedPx });
      } else if (RAW_TAGS.has(tag) || SHARED_TAGS.has(tag)) {
        const type = attr(node, 'type')?.initializer;
        const typeText = type && ts.isStringLiteral(type) ? type.text : null;
        if (!(typeText && NON_TEXT_TYPES.has(typeText))) {
          const init = attr(node, 'className')?.initializer;
          const classes = init ? classText(init, constants) : '';
          const px = baseFontPx(classes);
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
export function wrapperSizes(contentOf: (rel: string) => string): Map<string, WrapperInfo> {
  const out = new Map<string, WrapperInfo>();
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
    const visit = (node: ts.Node) => {
      if (px !== undefined) return;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        if (RAW_TAGS.has(tag) || SHARED_TAGS.has(tag)) {
          const init = attr(node, 'className')?.initializer;
          classes = init ? classText(init, constants) : '';
          px = baseFontPx(classes) ?? (SHARED_TAGS.has(tag) ? 16 : null);
          return;
        }
      }
      node.forEachChild(visit);
    };
    visit(body);
    if (px === undefined) throw new Error(`래퍼 ${name}(${rel})가 입력칸을 그리지 않는다 — WRAPPERS 표를 고칠 것`);
    if (px === null) throw new Error(`래퍼 ${name}(${rel})의 글자 크기를 정적으로 못 정한다(부모를 물려받음) — 래퍼에 크기를 줄 것`);
    out.set(name, { classes, px });
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
  const wrappers = wrapperSizes((rel) => {
    const c = contents.get(rel);
    if (c === undefined) throw new Error(`래퍼 정의 파일 ${rel}이 트리에 없다 — WRAPPERS 표를 고칠 것`);
    return c;
  });
  const tagPattern = new RegExp(`<(input|textarea|select|Input|Textarea|${Object.keys(WRAPPERS).join('|')})\\b`);
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
