import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'esbuild';

/**
 * The stub list for the esbuild-bundled layout specs (story 4586). One list for all of them — a spec that bundles a component
 * takes its stubs from here, not from a hand list of its own.
 *
 * Modules named in STUBS get the body written here. Any other `@/app/…` or `next/…` import gets a generated default: each name
 * the importer takes from it becomes a stub that returns null, and a default import becomes a stub that renders nothing. So one
 * more import in a bundled component does not turn a spec red that never needed that module (story 4586 AC2). A stub that is
 * called and needs a real value still fails, and says so on the page (the harness names the module it did not start on).
 */
export const STUBS: Record<string, string> = {
  '@/lib/db/client': 'export const fetchWithAuth = (u, i) => fetch(u, i);',
  '@/hooks/use-sse-notifications': 'export function useSseNotifications() {}',
  '@/hooks/use-flat-href': 'export function useFlatHref() { return (h) => h; }',
  '@/lib/phone-bridge': `export const isPhoneApp = () => !!window.__phone;
    export const phoneCall = async (k) => {
      if (k === 'pair.scan') return { ok: true, offer_id: '0f3c2a1e-1111-4222-8333-944455556666', setup_id: '12345678-9abc-4def-8123-456789abcdef', device_name: 'SYJ-MacBook-Pro', expires_at: new Date(Date.now() + 300000).toISOString() };
      if (k === 'device.key.info') return { ok: true, public_key: 'pk' };
      if (k === 'pair.mac') return { ok: true, mac: 'mac' };
      if (k === 'device.auth') return { id: 'x', ok: true, auth: 'biometric' };
      return { id: 'x', ok: false };
    };`,
  '@/lib/phone-answer': 'export async function answerOnPhone(id, decision) { return { kind: "answered", decision }; }',
  // story #4583: the inbox reads the org's remote control — the dashboard context comes with it. No remote-control answer → no «off» line.
  '@/app/dashboard/dashboard-shell': "export function useDashboardContext() { return { orgId: 'org-1' }; }",
  '@/components/viewer-time-zone': "export function useViewerTimeZone() { return 'Asia/Seoul'; }",
  // a client navigation like Next's: the link's own onClick first, then (unless prevented) no page load — the harness swaps the view
  'next/link': "import React from 'react'; export default function Link({ href, children, onClick, ...rest }) { return React.createElement('a', { href, ...rest, onClick: (e) => { onClick && onClick(e); if (!e.defaultPrevented && window.__clientNav) { e.preventDefault(); window.__clientNav(href); } } }, children); }",
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const STUB_FILTER = new RegExp(`^(${Object.keys(STUBS).map(esc).join('|')}|@/app/.+|next/.+)$`);

/** What one importer takes from `mod`: `import X, { a, b as c } from 'mod'` → hasDefault, names [a, b]. Type-only imports are skipped. */
function importsFrom(source: string, mod: string) {
  const re = new RegExp(`import\\s+([^;]*?)\\s+from\\s+['"]${esc(mod)}['"]`, 'g');
  const names = new Set<string>();
  let hasDefault = false;
  for (const m of source.matchAll(re)) {
    const clause = m[1]!;
    if (clause.startsWith('type ')) continue;
    const brace = clause.match(/\{([^}]*)\}/);
    for (const part of brace?.[1]?.split(',') ?? []) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (name && !name.startsWith('type ')) names.add(name);
    }
    if (clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim()) hasDefault = true;
  }
  return { names: [...names], hasDefault };
}

function generated({ names, hasDefault }: ReturnType<typeof importsFrom>) {
  const lines = names.map((name) => `export const ${name} = () => null;`);
  if (hasDefault) lines.push('export default () => null;');
  return lines.join('\n') || 'export {};';
}

/** The esbuild plugin every layout spec passes to its build. The stdin entry imports no stubbed module, so only real files are read. */
export function layoutStubPlugin(): Plugin {
  return {
    name: 'layout-stubs',
    setup(b) {
      b.onResolve({ filter: STUB_FILTER }, (a) => {
        const source = a.importer && a.importer !== '<stdin>' ? readFileSync(a.importer, 'utf8') : '';
        // One stub module per importer: esbuild keeps one module per path, so two importers that take different names from the same
        // unlisted module would otherwise share the first importer's stub (story 4586 review: «No matching export»).
        return { path: `${a.path}#${a.importer}`, namespace: 'stub', pluginData: { mod: a.path, ...importsFrom(source, a.path) } };
      });
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
        const d = a.pluginData as ReturnType<typeof importsFrom> & { mod: string };
        return {
            contents: STUBS[d.mod] ?? generated(d),
          loader: 'js',
          resolveDir: path.join(__dirname, '..', '..'),
        };
      });
    },
  };
}
