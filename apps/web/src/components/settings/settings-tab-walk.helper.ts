// story 4891 (UI-8 · settings pieces) — the shared import walk the per-tab «no old ui/ part in what the tab draws» tests use (not a test file: vitest does not collect it).
// From a tab's root components it follows every import under `components/` (ds/ and ui/ are not entered) and collects the old `@/components/ui/*` imports met on the way.
// Named exceptions — parts with no ds twin: `ui/toast` (the app's toast context hook) and `ui/tooltip` (the same part ds Avatar uses).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SRC = path.resolve(__dirname, '..', '..');
/** static `import … from '…'` / `export … from '…'` (single or double quotes), side-effect `import '…'`, dynamic `import('…')` — the one pattern the walk and its self-test use */
export const IMPORT_RE = /(?:(?:import|export)\s[^'"]*?from\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
export const NO_DS_TWIN = new Set(['@/components/ui/toast', '@/components/ui/tooltip']);

export function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(SRC, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) if (existsSync(c)) return c;
  return null;
}

const sep = path.sep;
const inComponents = (r: string) => r.includes(`${sep}components${sep}`) && !r.includes(`${sep}components${sep}ds${sep}`) && !r.includes(`${sep}components${sep}ui${sep}`) && !/\.test\./.test(r);

export function walkOldUi(rootFiles: string[]) {
  const seen = new Set<string>();
  const olds: string[] = [];
  const visit = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1]!;
      if (/^@\/components\/ui\//.test(spec) && !NO_DS_TWIN.has(spec)) olds.push(`${path.relative(SRC, f)} → ${spec}`);
      const r = resolveImport(f, spec);
      if (r && inComponents(r)) visit(r);
    }
  };
  rootFiles.forEach(visit);
  return { seen: [...seen].map((f) => path.relative(SRC, f)), olds };
}

/** `components/settings/<name>.tsx` */
export const settingsFile = (name: string) => path.join(SRC, 'components', 'settings', `${name}.tsx`);

const PAGE = path.join(SRC, 'app', '(authenticated)', 'settings', 'page.tsx');
/** the JSX source of one tab's `<TabsContent value="…">` block in the settings page */
export function tabBlock(value: string): string {
  const page = readFileSync(PAGE, 'utf8');
  const start = page.indexOf(`<TabsContent value="${value}">`);
  if (start < 0) throw new Error(`no <TabsContent value="${value}"> in settings/page.tsx`);
  return page.slice(start, page.indexOf('</TabsContent>', start));
}
/** the capitalised component names a tab block draws (TabsContent itself left out) */
export const namedComponents = (block: string) => [...new Set([...block.matchAll(/<([A-Z][A-Za-z]+)/g)].map((m) => m[1]!))].filter((n) => n !== 'TabsContent');
