/**
 * story #4375 — 접근 이름 없는 버튼 · 창을 고정한다(유나 PR 4753 화면 판 곁 발견: 목표 만들기 창 «✕»가 화면 읽기에 «버튼»으로만 읽힘).
 *
 * 기존 가드의 빈 자리: verify-no-hardcoded-aria-label.ts(aria-label 값이 영문 템플릿인가) · verify-repeated-row-action-names.ts
 * (행마다 같은 이름인가) · verify-nontext-icon-contrast.ts(대비) — 셋 다 «이름이 아예 없는» 버튼은 안 봤다.
 *
 * ## 무엇을 거나(AST)
 * ① 버튼: `<button>` · `<Button>` · `render={<Button/>}`(또는 `<button/>`)를 받는 요소(트리거류). 접근 이름 속성(aria-label ·
 *    aria-labelledby · title)이 없고, 자식(render 요소의 자식 포함)이 **아이콘 · 빈 소문자 요소(`<span/>`) · aria-hidden 가지뿐**이면 건다.
 * ② 창: DialogContent · SheetContent · AlertDialogContent · DrawerContent · DialogPrimitive/SheetPrimitive.Popup. 제목 요소(…Title) ·
 *    aria-label · aria-labelledby가 없고, 안에 `'dialog-title'` 글자(RecipeDetailView titleAs · embed-card header 관례)도 없으면 건다.
 *
 * ## 이 가드가 «못 잡는» 것(초록 = «다 봤다»로 읽지 않게)
 *   ㉠ 버튼 자식에 식(`{label}` · `{inner}`)이나 모르는 컴포넌트가 있으면 글을 그릴 수 있다고 보고 넘긴다 — 식이 아이콘만 담아도 못 잡는다.
 *   ㉡ `{...props}` 전달 버튼은 넘긴다(이름이 호출부에서 올 수 있음).
 *   ㉢ 이름 속성 값이 비었는지(`aria-label=""` · 빈 변수)는 안 본다 — 있다/없다만.
 *   ㉣ `<a>` · `role="button"` div 등 버튼 태그가 아닌 클릭 요소는 대상 밖.
 *   ㉤ 창: 안쪽 컴포넌트가 제목을 그리는지는 모른다 — 제목 요소 · 이름 속성 · 'dialog-title' 글자가 이 파일 안 그 창 가지에 없으면 건다(없는 쪽으로 기움).
 *
 * GRANDFATHER 없음 — 첫 전수(버튼 14 · 창 3)를 이 PR에서 전부 고쳤다. 작업 목록 390 시트는 [SID:4374]가 고친다. 새로 생기면 즉시 FAIL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface NamelessRef {
  kind: 'button' | 'dialog';
  file: string;
  line: number;
  tag: string;
}

const NAME_ATTRS = ['aria-label', 'aria-labelledby', 'title'];
const DIALOG_TAG = /^(DialogContent|SheetContent|AlertDialogContent|DrawerContent|DialogPrimitive\.Popup|SheetPrimitive\.Popup)$/;
const TITLE_TAG = /(^|\.)(DialogTitle|SheetTitle|AlertDialogTitle|DrawerTitle|Title)$/;
const isButtonTag = (tag: string) => tag === 'button' || tag === 'Button';

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attrMap(open: Opening, sf: ts.SourceFile): { attrs: Map<string, ts.JsxAttribute>; spread: boolean } {
  const attrs = new Map<string, ts.JsxAttribute>();
  let spread = false;
  for (const a of open.attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) spread = true;
    else attrs.set(a.name.getText(sf), a);
  }
  return { attrs, spread };
}

function isTrue(a: ts.JsxAttribute | undefined, sf: ts.SourceFile): boolean {
  return !!a && /^aria-hidden(=("true"|\{true\}))?$/.test(a.getText(sf).replace(/\s+/g, ''));
}

/** 이 파일에서 아이콘으로 볼 이름 — lucide-react · 아이콘 모듈의 가져온 이름 + `…Icon` · svg. */
function iconNames(sf: ts.SourceFile): Set<string> {
  const names = new Set(['svg']);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    if (!/lucide-react|icon/i.test(st.moduleSpecifier.getText(sf))) continue;
    for (const el of st.importClause.namedBindings.elements) names.add(el.name.text);
  }
  return names;
}

/** 자식이 이름이 될 글을 «낼 수 있나» — 모르면 true(㉠). 아이콘 · 빈 소문자 요소 · aria-hidden 가지 · null만이면 false. */
function childrenMayName(nodes: readonly ts.Node[], sf: ts.SourceFile, icons: Set<string>): boolean {
  const may = (n: ts.Node): boolean => {
    if (ts.isJsxText(n)) return n.getText(sf).trim() !== '';
    if (ts.isJsxExpression(n)) return n.expression ? exprMay(n.expression) : false;
    if (ts.isJsxFragment(n)) return n.children.some(may);
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = open.tagName.getText(sf);
      const { attrs } = attrMap(open, sf);
      if (isTrue(attrs.get('aria-hidden'), sf)) return false;
      if (tag === 'img') { const alt = attrs.get('alt'); return !!alt && !/^alt=(""|'')$/.test(alt.getText(sf)); } // alt="" = 장식 → 이름 아님
      if (icons.has(tag) || /Icon$/.test(tag)) return false;
      if (/^[A-Z]/.test(tag) || tag.includes('.')) return true; // 모르는 컴포넌트 — 글을 그릴 수 있음(㉠)
      return ts.isJsxElement(n) ? n.children.some(may) : false; // 소문자 요소는 안을 본다
    }
    return false;
  };
  const exprMay = (e: ts.Expression): boolean => {
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return may(e);
    if (ts.isParenthesizedExpression(e)) return exprMay(e.expression);
    if (ts.isConditionalExpression(e)) return exprMay(e.whenTrue) || exprMay(e.whenFalse);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return exprMay(e.right);
    if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(e) && e.text === 'undefined') return false;
    return true; // 식 · 글 · t() — 이름이 될 수 있음
  };
  return nodes.some(may);
}

export function scanContent(content: string, file: string): NamelessRef[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const icons = iconNames(sf);
  const refs: NamelessRef[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = open.tagName.getText(sf);
      const { attrs, spread } = attrMap(open, sf);
      // render 값 안의 <Button/>은 호스트가 대신 센다(이중 셈 방지).
      const inRender = ts.isJsxExpression(n.parent) && ts.isJsxAttribute(n.parent.parent) && n.parent.parent.name.getText(sf) === 'render';
      const renderInit = attrs.get('render')?.initializer;
      const renderEl = renderInit && ts.isJsxExpression(renderInit) ? renderInit.expression : undefined;
      const renderOpen = renderEl && (ts.isJsxElement(renderEl) ? renderEl.openingElement : ts.isJsxSelfClosingElement(renderEl) ? renderEl : undefined);
      const renderIsButton = !!renderOpen && isButtonTag(renderOpen.tagName.getText(sf));

      if (!inRender && (isButtonTag(tag) || renderIsButton)) {
        const r = renderOpen ? attrMap(renderOpen, sf) : { attrs: new Map<string, ts.JsxAttribute>(), spread: false };
        const named = NAME_ATTRS.some((k) => attrs.has(k) || (renderIsButton && r.attrs.has(k)));
        const hidden = isTrue(attrs.get('aria-hidden'), sf);
        const children = [...(ts.isJsxElement(n) ? n.children : []), ...(renderIsButton && renderEl && ts.isJsxElement(renderEl) ? renderEl.children : [])];
        if (!named && !hidden && !spread && !(renderIsButton && r.spread) && !childrenMayName(children, sf, icons)) {
          refs.push({ kind: 'button', file, line: lineOf(n), tag: renderIsButton ? `${tag} render=<${renderOpen!.tagName.getText(sf)}>` : tag });
        }
      }

      if (ts.isJsxElement(n) && DIALOG_TAG.test(tag) && !spread && !attrs.has('aria-label') && !attrs.has('aria-labelledby')) {
        let titled = false;
        const find = (x: ts.Node): void => {
          if (titled) return;
          if ((ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x)) && TITLE_TAG.test((ts.isJsxElement(x) ? x.openingElement : x).tagName.getText(sf))) titled = true;
          else if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && x.text === 'dialog-title') titled = true;
          else x.forEachChild(find);
        };
        n.children.forEach(find);
        if (!titled) refs.push({ kind: 'dialog', file, line: lineOf(n), tag });
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return refs;
}

const MIN_EXPECTED_FILES = 400;

export function scanRepo(root: string): NamelessRef[] {
  const out: NamelessRef[] = [];
  let files = 0;
  const walkDir = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walkDir(full); continue; }
      if (!e.name.endsWith('.tsx') || /\.(test|spec|stories)\.tsx$/.test(e.name)) continue;
      // 원형(ui/dialog · ui/sheet)은 `{...props}`로 이름을 호출부에서 받는다 — ㉡과 같은 이유로 제외.
      files += 1;
      out.push(...scanContent(readFileSync(full, 'utf8'), path.relative(root, full).split(path.sep).join('/')));
    }
  };
  walkDir(root);
  if (files < MIN_EXPECTED_FILES) throw new Error(`FAIL: 검사 대상 .tsx가 ${files}개뿐(root=${root}) — 가드가 헛돌고 있다.`);
  return out;
}

function main(): number {
  let refs: NamelessRef[];
  try {
    refs = scanRepo(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src'));
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const buttons = refs.filter((r) => r.kind === 'button');
  const dialogs = refs.filter((r) => r.kind === 'dialog');
  console.log(`[4375] 접근 이름 없는 버튼 ${buttons.length}건 · 이름 없는 창 ${dialogs.length}건(머리 주석 ㉠~㉤ = 못 잡는 것)`);
  for (const r of buttons) console.error(`  - ${r.file}:${r.line} <${r.tag}> — 아이콘만 있는 버튼: aria-label={t(…)}(닫기 = common.close · 행마다면 항목을 품게)`);
  for (const r of dialogs) console.error(`  - ${r.file}:${r.line} <${r.tag}> — 창 이름 없음: …Title(보이는 제목) 또는 sr-only …Title · aria-labelledby`);
  return refs.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
