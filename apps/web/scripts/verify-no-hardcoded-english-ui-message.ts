/**
 * story #4359(PO 21:00Z 넓히기) — 화면에 뜨는 **문자열 상태**에 영어 문장이 t() 없이 박히는 클래스를 고정한다. JSX 글자는
 * verify-no-raw-ascii-jsx-text.ts, 속성값은 verify-no-raw-ascii-jsx-attr.ts, 브라우저 창은 verify-no-hardcoded-english-browser-dialog.ts가
 * 본다 — 코드 안에서 오류 · 안내 상태에 넣어 나중에 그려지는 문장은 아무도 안 봤다(MFA `setError('That code did not match…')` ·
 * 문서 임베드 `setError('Document not found')` · API 키 `addToast({ title: 'Error' })`).
 *
 * 판별(AST · 같은 `isUntranslatedCopy`):
 * - `set…(Error|Message|Notice|Warning|Hint)(<문자열>)` — 사람에게 보이는 상태 setter. `set…Status('loading')` 같은 상태 **코드**는 제외.
 * - `addToast / toast / showToast({ title | body | description | message: <문자열> })` · `toast.X(<문자열>)`.
 * GRANDFATHER 없음 — 첫 전수를 이 PR에서 전부 고쳤다. 새로 생기면 즉시 FAIL.
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
    node.forEachChild(walk);
  }
  walk(sf);
  return refs;
}

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

function main(): number {
  const refs = scanRepo(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src'));
  console.log(`[4359] 화면 문자열 상태(오류 · 안내 setter · toast) 영어 문장 스캔 — 걸림 ${refs.length}건`);
  for (const r of refs) console.error(`  - ${r.file}:${r.line} ${r.where} ${JSON.stringify(r.value)} — t()로(ko · en)`);
  return refs.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
