// The ONE place a layout spec turns its esbuild browser bundle into Tailwind candidates (story 4929 · PO 11-14).
// A layout spec bundles the REAL components and compiles Tailwind from the class strings it finds in that bundle. Reading only the
// «double-quoted strings» with a regex missed every class a component spells in a TEMPLATE LITERAL (`…${CONSTANT}`): since 5771 the ds
// Toggle's own classes (w-7 · h-4 …) never reached the CSS — the switch track drew 14 px wide and shell-touch.4890's «원격 제어» row measured
// 41 × 44 (a failure of the harness, not of the product: the real Tailwind scan reads source text). A regex over bundle text is also
// fragile in itself (an empty string, a string holding a quote that esbuild prints in single quotes, a regex literal with a quote …
// each slips the quote pairing). So the bundle is PARSED (TypeScript's parser, already a dev dependency) and every string and every
// template part is read from the syntax tree: exact, no pairing. A spec must not write its own scan (check-layout-stubs.mjs fails when one does).
import { createRequire } from 'node:module';

const req = createRequire(__filename);

export function tailwindCandidates(js: string): string[] {
  const ts = req('typescript') as typeof import('typescript');
  const found = new Set<string>();
  const add = (text: string) => { for (const token of text.split(/\s+/)) if (token) found.add(token); };
  // explicit stack: a bundle can nest deeper than the call stack likes
  const stack: import('typescript').Node[] = [ts.createSourceFile('bundle.js', js, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)];
  while (stack.length) {
    const node = stack.pop()!;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node.text);
    ts.forEachChild(node, (child) => { stack.push(child); });
  }
  return [...found];
}
