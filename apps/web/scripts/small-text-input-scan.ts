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
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const NON_TEXT_TYPES = new Set(['checkbox', 'radio', 'hidden', 'file', 'range', 'color', 'submit', 'button', 'image', 'reset']);
const RAW_TAGS = new Set(['input', 'textarea', 'select']);
const SHARED_TAGS = new Set(['Input', 'Textarea']);
const NAMED_SIZES: Record<string, number> = { 'text-xs': 12, 'text-sm': 14, 'text-base': 16, 'text-lg': 18, 'text-xl': 20, 'text-2xl': 24, 'text-3xl': 30 };

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

export function scanSource(content: string, file: string): { sites: SmallTextInputSite[]; inherits: number } {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = stringConstants(sf);
  const sites: SmallTextInputSite[] = [];
  let inherits = 0;
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (RAW_TAGS.has(tag) || SHARED_TAGS.has(tag)) {
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
  return { sites, inherits };
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

/** 파일별 16px 미만 칸 수(0인 파일은 뺌) · 전체 목록. */
export function scanTree(srcRoot: string): { perFile: Record<string, number>; sites: SmallTextInputSite[]; fileCount: number } {
  const files = tsxFiles(srcRoot);
  const perFile: Record<string, number> = {};
  const sites: SmallTextInputSite[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    if (!/<(input|textarea|select|Input|Textarea)\b/.test(content)) continue;
    const found = scanSource(content, rel).sites;
    if (found.length) { perFile[rel] = found.length; sites.push(...found); }
  }
  return { perFile, sites, fileCount: files.length };
}
