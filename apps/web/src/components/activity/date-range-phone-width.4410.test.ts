import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// story #4410 C — at 16px each date input grew 156 → 172px, pushing the second one to 393px at a 390 viewport (clipped by
// overflow-hidden). Phones shrink and share the row (min-w-0 flex-1 px-2); sm and up keep the old natural width (sm:flex-none sm:px-3).
const SRC = path.resolve(__dirname, '../..');
const FILES = ['components/activity/activity-log-view.tsx', 'components/agents/agent-runs-list.tsx', 'components/activity/team-activity-view.tsx'];

function dateInputClasses(rel: string): string[][] {
  const sf = ts.createSourceFile(rel, readFileSync(path.join(SRC, rel), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[][] = [];
  const attr = (n: ts.JsxOpeningLikeElement, name: string) =>
    n.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name);
  const visit = (n: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === 'input') {
      const type = attr(n, 'type')?.initializer;
      if (type && ts.isStringLiteral(type) && type.text === 'date') {
        const cls = attr(n, 'className')?.initializer;
        out.push(cls && ts.isStringLiteral(cls) ? cls.text.split(/\s+/) : []);
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

describe('date range inputs fit a 390px row', () => {
  it.each(FILES)('%s — both date inputs shrink on phones and keep their width from sm up', (rel) => {
    const inputs = dateInputClasses(rel);
    expect(inputs).toHaveLength(2);
    for (const cls of inputs) {
      expect(cls).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'px-2', 'sm:flex-none', 'sm:px-3', 'text-base', 'lg:text-sm']));
    }
  });
});
