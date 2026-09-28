/**
 * story #4359(PO 21:00Z 넓히기) — 화면에 뜨는 **문자열 상태**에 영어 문장이 t() 없이 박히는 클래스를 고정한다. JSX 글자는
 * verify-no-raw-ascii-jsx-text.ts, 속성값은 verify-no-raw-ascii-jsx-attr.ts, 브라우저 창은 verify-no-hardcoded-english-browser-dialog.ts가
 * 본다 — 코드 안에서 오류 · 안내 상태에 넣어 나중에 그려지는 문장은 아무도 안 봤다(MFA `setError('That code did not match…')` ·
 * 문서 임베드 `setError('Document not found')` · API 키 `addToast({ title: 'Error' })`).
 *
 * 판별(AST · 같은 `isUntranslatedCopy`):
 * - `set…(Error|Message|Notice|Warning|Hint)(<문자열>)` — 사람에게 보이는 상태 setter. `set…Status('loading')` 같은 상태 **코드**는 제외.
 * - `addToast / toast / showToast({ title | body | description | message: <문자열> })` · `toast.X(<문자열>)`.
 * - (까디르 4740 ②) **JSX 자식 식 `{…}` 안의 문자열 · 템플릿 리터럴** — `{copied ? 'Copied!' : 'Copy'}` · `{x && \` • Last used: ${…}\`}`처럼
 *   JSX 글자 가드(verify-no-raw-ascii-jsx-text.ts — 식 밖 글자만)가 못 보던 자리. 템플릿은 글자 조각을 이어 판정 · 한글이 없으면
 *   ASCII 밖 기호(• ⚠ …)를 걷고 판정(기호 때문에 놓치지 않게). 식 안의 호출 인자 · 비교 · 속성 · 안쪽 JSX는 이 축 밖(각자 자리 · 가드).
 * - (story #4377) **객체 리터럴의 사람용 속성** — `{ title: 'Heading 1' }`처럼 객체(배열 안 객체 포함)의 `title` · `label` · `description` ·
 *   `placeholder` · `tooltip` · `ariaLabel` · `heading` · `subtitle` · `caption` · `hint` · `helperText` · `empty*` · `*Label` 값에 박힌 영어 문장
 *   (문서 편집기 슬래시 메뉴 제목 20개가 이렇게 한국어 화면에 영어로 떴다). camelCase · kebab-case 토큰(i18n 키 이름 · 클래스)은 코드라 뺀다.
 *   브랜드 · 외부 채널 페이로드 · 렌더 0 데이터는 OBJECT_PROP_ALLOWLIST(이유), 알고 남긴 자리는 OBJECT_PROP_BASELINE(줄이기만).
 * **아직 못 보는 자리**(까디르 4740 · 범위를 밝혀 둔다 — 이 가드가 영어를 전부 잡는다고 읽지 말 것):
 *   - 식별자 · 배열 원소 문자열로 두었다가 그리는 문장(`const labels = { 1: '1-step' }`의 **숫자 · 임의 키** → `{labels[n]}` · `{msg}`) —
 *     위 사람용 속성 이름이 아닌 키 · 맨 문자열 배열은 값이 그려지는지 코드만으로 못 가른다. `message` · `text` · `name` 키도 이 축 밖
 *     (오류 객체 · 클래스 이름 · 확장 이름이 대부분 — 4377 전수에서 사람에게 그려지는 자리 0).
 *   - 템플릿 **치환 자리 안**의 영어(`\`${n} ${n === 1 ? 'day' : 'days'}\``) — 글자 조각만 잇고 치환 식은 안 본다.
 *   - 호출 인자(`{format('Updated')}`) — 호출 안은 이 축 밖.
 *   - JSX **속성** 값 — verify-no-raw-ascii-jsx-attr.ts 담당.
 *   - `||` · `??` 의 **왼쪽**(`{'Untitled' || x}`) — 오른쪽(대체값)만 따라간다.
 * GRANDFATHER 없음(setter · toast) — 첫 전수를 이 PR에서 전부 고쳤다. JSX 식 축은 ALLOWLIST(코드 토큰 · 브랜드) + 이름 붙인 BASELINE(줄이기만).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isUntranslatedCopy } from './lib/is-untranslated-copy';

// `setError` 자체도(가운데 이름 없이) — 처음 정규식은 가운데 글자를 하나 이상 요구해 가장 흔한 setError를 놓쳤다.
const MESSAGE_SETTER = /^set(?:[A-Z]\w*)?(Error|Message|Notice|Warning|Hint)$/;
const TOAST_CALLEE = /^(addToast|toast|showToast)$/;
const TOAST_FIELDS = new Set(['title', 'body', 'description', 'message']);

export interface UiMessageRef {
  file: string;
  line: number;
  where: string;
  value: string;
}

/** 소문자 한 낱말(`forbidden` · `other`)은 화면 문장이 아니라 상태 코드다(그려질 때 t()로 번역하는 쪽) — 제외. */
const CODE_TOKEN = /^[a-z][a-z0-9_]*$/;
const isCopy = (v: string) => !CODE_TOKEN.test(v) && isUntranslatedCopy(v);

/** JSX 식 축 — 사람 말이 아닌 자리(이유와 함께). 키 = `파일::값`. */
export const JSX_EXPR_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['components/organization/event-definer-form.tsx::org. .', '이벤트 키 접두 `org.{slug}.` — 코드 토큰'],
  ['components/storage/storage-folder-tree.tsx::Sprintable', '제품 이름(프로젝트 이름이 없을 때) — 브랜드'],
]);
/** JSX 식 축 — 알고 있는 남은 자리(줄이기만 · 새로 생기면 FAIL). 고치면 여기서 빼야 초록(stale도 FAIL). */
// 첫 전수의 단 하나(설정 › 워크플로 갤러리 단계 배지 `${count}-step`)는 이 PR에서 고쳤다(PO 23:36Z) — 비어 있음. 새 자리는 고치거나 PO 승인으로 등재.
export const JSX_EXPR_BASELINE: ReadonlyMap<string, string> = new Map([]);

/** story #4377 — 객체 속성 축: 사람에게 그려지는 이름의 속성만. */
const UI_OBJECT_KEYS = new Set([
  'title', 'label', 'description', 'placeholder', 'tooltip', 'ariaLabel', 'heading', 'subtitle', 'caption', 'hint', 'helperText',
  'emptyText', 'emptyLabel', 'buttonLabel', 'confirmLabel', 'cancelLabel',
]);
/** camelCase(i18n 키 이름 `intentSuggestionApprovalCta`) · kebab-case(클래스)는 코드 토큰. */
const CODE_IDENT = /^[a-z][a-zA-Z0-9]*$|^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const isObjectCopy = (v: string) => !/[가-힣]/.test(v) && !CODE_IDENT.test(v) && isCopy(v);

/** 객체 속성 축 — 사람 말이 아닌 자리 · 번역하지 않는 자리(이유와 함께). 키 = `파일::값`. */
export const OBJECT_PROP_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['components/settings/linked-accounts-section.tsx::Google', '로그인 제공자 이름 — 브랜드'],
  ['components/settings/linked-accounts-section.tsx::Apple', '로그인 제공자 이름 — 브랜드'],
  ...['Hermes', 'OpenClaw', 'Gemini', 'Grok', 'Pi', 'OpenCode', 'Claude Code', 'Codex', 'Cursor', 'Sprintable'].map(
    (brand) => [`lib/runtime-capabilities.ts::${brand}`, '에이전트 런타임 · 제품 이름 — 브랜드'] as const,
  ),
  ['services/memo.ts::latest reply', '메모 API timeline 라벨(데이터 값) — FE 렌더 0(grep · 4377 전수)'],
  ['app/manifest.ts::The organization OS that closes open loops. Kanban, memos, standups, retros, MCP server — with AI agents as first-class team members.',
    'PWA 매니페스트 설명 — 단일 로케일 정적 설치 메타(로케일별 매니페스트는 별건)'],
]);
/** 객체 속성 축 — 알고 남긴 자리(줄이기만 · 새로 생기면 FAIL · 고치면 빼야 초록). */
export const OBJECT_PROP_BASELINE: ReadonlyMap<string, string> = new Map([
  ['app/privacy/page.tsx::Privacy Policy — Sprintable', '법무 문서 탭 제목(metadata) — 본문은 한국어 · 로케일 metadata 경로 없음(별건)'],
  ['app/refund-policy/page.tsx::Refund Policy — Sprintable', '법무 문서 탭 제목(metadata) — 위와 같음'],
  ['app/terms/page.tsx::Terms of Service — Sprintable', '법무 문서 탭 제목(metadata) — 위와 같음'],
]);

/** 템플릿 글자 조각을 잇는다(치환 자리는 공백). 한글이 있으면 번역된 문장. 없으면 ASCII 밖 기호를 걷고 판정. */
function jsxExprCopy(e: ts.Node): string | undefined {
  let text: string | undefined;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) text = e.text;
  else if (ts.isTemplateExpression(e)) text = [e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)].join(' ');
  if (text === undefined || /[가-힣]/.test(text)) return undefined;
  const ascii = text.replace(/[^\x00-\x7F]/g, ' ');
  return isCopy(ascii.trim()) ? text : undefined;
}

function literal(e: ts.Expression | undefined): string | undefined {
  return e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;
}

export function scanContent(content: string, file: string): UiMessageRef[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const refs: UiMessageRef[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      const onToastObject = ts.isPropertyAccessExpression(callee) && callee.expression.getText(sf) === 'toast';
      const arg = node.arguments[0];
      const first = literal(arg);
      if (MESSAGE_SETTER.test(name) && first !== undefined && isCopy(first)) refs.push({ file, line: at(node), where: `${name}()`, value: first });
      if ((TOAST_CALLEE.test(name) || onToastObject) && first !== undefined && isCopy(first)) refs.push({ file, line: at(node), where: `${name}()`, value: first });
      if ((TOAST_CALLEE.test(name) || onToastObject) && arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (!ts.isPropertyAssignment(p) || !TOAST_FIELDS.has(p.name.getText(sf))) continue;
          const v = literal(p.initializer);
          if (v !== undefined && isCopy(v)) refs.push({ file, line: at(p), where: `${name}({${p.name.getText(sf)}})`, value: v });
        }
      }
    }
    if (ts.isJsxExpression(node) && node.expression && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      walkJsxChildExpr(node.expression);
    }
    // story #4377 — 객체 리터럴의 사람용 속성(배열 안 객체 포함).
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && !isToastArgument(node.parent)) {
      const key = node.name.getText(sf).replace(/^['"]|['"]$/g, '');
      const v = literal(node.initializer);
      if (UI_OBJECT_KEYS.has(key) && v !== undefined && isObjectCopy(v)) refs.push({ file, line: at(node), where: `{${key}: …}`, value: v });
    }
    node.forEachChild(walk);
  }
  // JSX 자식 식 안 — 삼항 · && · ?? · 괄호 · 템플릿 자체만 따라간다(호출 인자 · 비교 · 속성 · 안쪽 JSX는 제 자리 규칙).
  function walkJsxChildExpr(e: ts.Node): void {
    const copy = jsxExprCopy(e);
    if (copy !== undefined) { refs.push({ file, line: at(e), where: '{JSX 식}', value: copy }); return; }
    if (ts.isParenthesizedExpression(e)) walkJsxChildExpr(e.expression);
    else if (ts.isConditionalExpression(e)) { walkJsxChildExpr(e.whenTrue); walkJsxChildExpr(e.whenFalse); }
    else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) walkJsxChildExpr(e.right);
  }
  // toast 인자 객체는 위 toast 축이 이미 본다(같은 자리를 두 번 세지 않게).
  function isToastArgument(obj: ts.ObjectLiteralExpression): boolean {
    const call = obj.parent;
    if (!call || !ts.isCallExpression(call) || call.arguments[0] !== obj) return false;
    const callee = call.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    return TOAST_CALLEE.test(name) || (ts.isPropertyAccessExpression(callee) && callee.expression.getText(sf) === 'toast');
  }
  walk(sf);
  return refs;
}

/** JSX 식 축의 키(`파일::값` · 템플릿은 글자 조각 이음). */
export const jsxExprKey = (r: UiMessageRef) => `${r.file}::${r.value}`;

function scanRepo(root: string): UiMessageRef[] {
  const out: UiMessageRef[] = [];
  const walkDir = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walkDir(full); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.(test|spec|stories)\.tsx?$/.test(e.name) || e.name.endsWith('.d.ts')) continue;
      out.push(...scanContent(readFileSync(full, 'utf8'), path.relative(root, full).split(path.sep).join('/')));
    }
  };
  walkDir(root);
  return out;
}

/** 객체 속성 축 자리인지(`{title: …}` 모양). */
export const isObjectPropRef = (r: UiMessageRef) => /^\{\w+: …\}$/.test(r.where);

export function judge(all: UiMessageRef[]): { fresh: UiMessageRef[]; stale: string[] } {
  const seenJsx = new Set<string>();
  const seenObj = new Set<string>();
  const fresh = all.filter((r) => {
    const k = jsxExprKey(r);
    if (r.where === '{JSX 식}') {
      seenJsx.add(k);
      return !JSX_EXPR_ALLOWLIST.has(k) && !JSX_EXPR_BASELINE.has(k);
    }
    if (isObjectPropRef(r)) {
      seenObj.add(k);
      return !OBJECT_PROP_ALLOWLIST.has(k) && !OBJECT_PROP_BASELINE.has(k);
    }
    return true;
  });
  const stale = [
    ...[...JSX_EXPR_BASELINE.keys()].filter((k) => !seenJsx.has(k)),
    ...[...OBJECT_PROP_BASELINE.keys()].filter((k) => !seenObj.has(k)),
  ];
  return { fresh, stale };
}

function main(): number {
  const all = scanRepo(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src'));
  const { fresh, stale } = judge(all);
  console.log(`[4359 · 4377] 화면 문자열 상태(오류 · 안내 setter · toast · JSX 식 안 문자열 · 객체 사람용 속성) 영어 문장 스캔 — 검출 ${all.length}건 · ALLOWLIST ${JSX_EXPR_ALLOWLIST.size + OBJECT_PROP_ALLOWLIST.size} · BASELINE ${JSX_EXPR_BASELINE.size + OBJECT_PROP_BASELINE.size} · 신규 ${fresh.length}건 · stale ${stale.length}건`);
  for (const r of fresh) console.error(`  - ${r.file}:${r.line} ${r.where} ${JSON.stringify(r.value)} — t()로(ko · en)`);
  for (const k of stale) console.error(`  - stale BASELINE ${k} — 고쳐졌으면 BASELINE에서 뺄 것`);
  return fresh.length || stale.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
