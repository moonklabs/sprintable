/**
 * story #4359 — 사람이 읽는 영어 문구가 **브라우저 창 인자**(prompt · confirm · alert, `window.` 포함)에 t() 없이 박히는 클래스를 고정한다.
 *
 * 기존 가드의 빈 자리: verify-no-raw-ascii-jsx-text.ts(JSX 텍스트 자식) · verify-no-raw-ascii-jsx-attr.ts(텍스트 속성값 · baseline 있음) ·
 * verify-no-hardcoded-aria-label.ts(aria-label 템플릿)는 JSX만 본다 — 코드 안 함수 호출 인자는 아무도 안 봤다. 그래서 문서 트리 이름
 * 바꾸기 `prompt('Enter new title:')` · 링크 넣기 `window.prompt('URL:')` 셋이 ko 조직에도 영어로 새었다. 판별은 같은 `isUntranslatedCopy`
 * (새 기전 없음 · AST).
 *
 * GRANDFATHER 없음 — 첫 전수 4곳을 이 PR에서 전부 고쳤다(이름 바꾸기 = 디자인 창 · 링크 셋 = i18n 문구). 새로 생기면 즉시 FAIL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isUntranslatedCopy } from './lib/is-untranslated-copy';

export const DIALOGS = new Set(['prompt', 'confirm', 'alert']);

export interface DialogLiteralRef {
  file: string;
  line: number;
  call: string;
  value: string;
}

export function scanContent(content: string, file: string): DialogLiteralRef[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const refs: DialogLiteralRef[] = [];
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && callee.expression.getText(sf) === 'window' ? callee.name.text : '';
      const arg = node.arguments[0];
      const value = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
      if (DIALOGS.has(name) && value !== undefined && isUntranslatedCopy(value)) {
        refs.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, call: `${name}()`, value });
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return refs;
}

function scanRepo(root: string): DialogLiteralRef[] {
  const out: DialogLiteralRef[] = [];
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
  console.log(`[4359] 브라우저 창(prompt · confirm · alert) 인자 영어 문구 스캔 — 걸림 ${refs.length}건`);
  for (const r of refs) console.error(`  - ${r.file}:${r.line} ${r.call} ${JSON.stringify(r.value)} — t()로(ko · en), 이름 입력류는 디자인 창으로`);
  return refs.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
