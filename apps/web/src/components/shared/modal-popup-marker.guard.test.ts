// story #4373(PO 04:46Z) — AnchoredPopover는 Base UI 모달 팝업 안이면 그 팝업으로 포털한다(밖이면 Base UI가 aria-hidden으로 숨김). 모달을
// 가르는 표지는 한 이름 `data-modal-popup`(anchored-popover.tsx MODAL_POPUP_SELECTOR). 이 가드는 `@base-ui/react/{dialog,alert-dialog,drawer}`의
// Popup을 그리는 모든 자리(래퍼 · 래퍼 밖 직접 사용)가 그 표지를 달았는지 본다 — 빠뜨리면 그 모달 안 팝오버가 조용히 숨는 결함이 되살아난다.
// 방법(소스 AST · 읽기만): 그 모듈에서 가져온 이름(`Dialog as DialogPrimitive` 등)을 모으고, `<그이름.Popup …>` 여는 태그에 data-modal-popup이 있는지.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '../..');
const MODAL_MODULES = new Set(['@base-ui/react/dialog', '@base-ui/react/alert-dialog', '@base-ui/react/drawer']);

export function unmarkedModalPopups(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !MODAL_MODULES.has(st.moduleSpecifier.text)) continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.add(el.name.text);
    if (nb && ts.isNamespaceImport(nb)) names.add(nb.name.text);
  }
  const misses: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ts.isPropertyAccessExpression(n.tagName)
      && n.tagName.name.text === 'Popup' && names.has(n.tagName.expression.getText(sf))) {
      const marked = n.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'data-modal-popup');
      if (!marked) misses.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return misses;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(full);
    return /\.tsx$/.test(e.name) && !/\.(test|stories)\.tsx$/.test(e.name) ? [full] : [];
  });
}

describe('Base UI 모달 Popup 표지(story #4373)', () => {
  it('실 트리: 모달 Popup 전부가 data-modal-popup을 단다(래퍼 둘 + 래퍼 밖 셋 이상)', () => {
    const files = sources(SRC);
    const popups = files.filter((f) => /@base-ui\/react\/(dialog|alert-dialog|drawer)/.test(fs.readFileSync(f, 'utf8')));
    expect(popups.length).toBeGreaterThanOrEqual(5);
    const misses = files.flatMap((f) => unmarkedModalPopups(path.relative(SRC, f), fs.readFileSync(f, 'utf8')));
    expect(misses).toEqual([]);
  });

  it('양성 대조: 표지 없는 Popup은 걸리고(별칭 · 여러 모듈), 다른 모듈의 Popup은 안 걸린다', () => {
    const src = `
      import { Dialog as D } from '@base-ui/react/dialog';
      import { AlertDialog } from '@base-ui/react/alert-dialog';
      import { Popover } from '@base-ui/react/popover';
      export const A = () => (<><D.Popup className="x">a</D.Popup><AlertDialog.Popup /><D.Popup data-modal-popup="">b</D.Popup><Popover.Popup /></>);`;
    expect(unmarkedModalPopups('x.tsx', src)).toEqual(['x.tsx:5', 'x.tsx:5']);
  });
});
