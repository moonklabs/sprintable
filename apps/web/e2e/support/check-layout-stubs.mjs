// Story 4586 — the shared layout stub plugin, checked with esbuild alone (no browser). Run from apps/web:
//   node e2e/support/check-layout-stubs.mjs
// Three checks, the ones a browser run would otherwise be the only proof of:
//   1. a bundled component that imports an unlisted next/… and @/app/… module still bundles and runs (the stubs are in);
//   2. the generated @/app stub exports the name the importer takes, and calling the component does not throw;
//   3. a module that is neither listed nor under @/app or next/ fails the build, and the failure names it.
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..', '..');
const req = createRequire(import.meta.url);
const tmp = path.join(HERE, '.stubcheck');

// The plugin is TypeScript. Bundle it to CJS inside e2e/support, so its __dirname resolves the same way it does in a spec.
const pluginBundle = await build({
  entryPoints: [path.join(HERE, 'layout-stubs.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
});
mkdirSync(tmp, { recursive: true });
const pluginFile = path.join(HERE, '.layout-stubs.check.cjs');
writeFileSync(pluginFile, pluginBundle.outputFiles[0].text);
const { layoutStubPlugin } = req(pluginFile);
rmSync(pluginFile);

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const buildOptions = (entry) => ({
  entryPoints: [entry], bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
  tsconfig: path.join(WEB, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, plugins: [layoutStubPlugin()],
});

// ① + ② — a component that takes one unlisted next/ import and one @/app import
const probe = path.join(tmp, 'probe.tsx');
writeFileSync(probe, [
  "import Link from 'next/link';",
  "import { usePathname } from 'next/navigation';",
  "import { useThing } from '@/app/stubcheck/thing';",
  'export function Probe() {',
  '  const thing = useThing();',
  '  return <Link href="/a">{String(thing)}{String(usePathname)}</Link>;',
  '}',
].join('\n'));
try {
  const out = await build(buildOptions(probe));
  const mod = { exports: {} };
  new Function('module', 'exports', out.outputFiles[0].text)(mod, mod.exports);
  check('① bundled component with unlisted next/ and @/app imports builds', true);
  check('② generated @/app stub exports the imported name', typeof mod.exports.Probe === 'function');
  let threw = null;
  try { mod.exports.Probe(); } catch (e) { threw = e; }
  check('② calling the component does not throw with stubs in place', threw === null, threw ? String(threw.message) : '');
} catch (e) {
  check('① bundled component with unlisted next/ and @/app imports builds', false, String(e.message).split('\n')[0]);
}

// ③ — a module no rule covers must fail, and the failure must name it
const unstubbed = path.join(tmp, 'unstubbed.tsx');
writeFileSync(unstubbed, "import { x } from '@/lib/no-stub';\nexport const y = x;\n");
try {
  await build(buildOptions(unstubbed));
  check('③ unlisted module outside @/app and next/ fails the build', false, 'it built');
} catch (e) {
  check('③ unlisted module outside @/app and next/ fails the build', true);
  check('③ the failure names the module', String(e.message).includes('@/lib/no-stub'), String(e.message).split('\n')[0]);
}

rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error(`layout stub check: ${failures.length} failed`);
  process.exit(1);
}
console.log('layout stub check: all passed');
