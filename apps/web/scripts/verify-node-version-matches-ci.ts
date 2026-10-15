/**
 * story #4449 — the runtime we test is the runtime we ship. The web server's Node (apps/web/Dockerfile) and CI's Node
 * (.github/workflows/ci.yml `node-version`) must be the same exact version, and the image must be pinned by digest.
 *
 * Why: `node:20-alpine` was a moving tag — dev 00cf66694 ran Node 20.20.2 (ICU 78.2) while CI ran 22.23.3 (ICU 78.3), and ICU
 * patches draw Korean clock times differently (78.2 «AM 7:18» · 78.3 «오전 7:18»). A server-drawn time would then differ from
 * the one our tests saw. CI's own `'22'` picked each runner's cached patch the same way (4866: red on 22.23.2, green on 22.23.3).
 *
 * Checks:
 * - every `FROM` in apps/web/Dockerfile that names the Node image uses an exact version (`node:X.Y.Z-…`) and a digest (`@sha256:`),
 *   and all of them are the same reference (base and runner never drift apart);
 * - every `node-version:` in ci.yml is exactly X.Y.Z, the same as the Dockerfile's;
 * - there is at least one of each (a renamed image or a removed step is RED, not a silent pass).
 *
 * Not seen (declared): other workflows (lighthouse-ci · stack-pr-frontend-preview · publish-connectors still say `'22'`), the root
 * Dockerfile (the public self-host image from main), `.nvmrc` (local development) — none of them builds or tests the shipped web
 * server. A digest is checked for shape only; that it is the index of that tag was read once from mirror.gcr.io (see Dockerfile).
 *
 * Usage: tsx scripts/verify-node-version-matches-ci.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPS_WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APPS_WEB, '../..');
const DOCKERFILE = path.join(APPS_WEB, 'Dockerfile');
const CI_YML = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

export interface NodeFrom { line: number; image: string; version: string | null; digest: string | null }

/** `FROM` lines that name the Node image (a stage built `FROM base` is not one). */
export function dockerNodeFroms(dockerfile: string): NodeFrom[] {
  const out: NodeFrom[] = [];
  dockerfile.split('\n').forEach((raw, i) => {
    const m = raw.trim().match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/i);
    if (!m) return;
    const image = m[1]!;
    if (!/(^|\/)node:/.test(image)) return;
    const tag = image.split('@')[0]!.split(':')[1] ?? '';
    const version = tag.match(/^(\d+\.\d+\.\d+)(?:-|$)/)?.[1] ?? null;
    const digest = image.match(/@(sha256:[0-9a-f]{64})$/)?.[1] ?? null;
    out.push({ line: i + 1, image, version, digest });
  });
  return out;
}

export interface CiNode { line: number; value: string }

/** Every `node-version:` value in a workflow file, quotes removed. */
export function ciNodeVersions(yml: string): CiNode[] {
  const out: CiNode[] = [];
  yml.split('\n').forEach((raw, i) => {
    const m = raw.match(/^\s*node-version\s*:\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/);
    if (m) out.push({ line: i + 1, value: m[1]! });
  });
  return out;
}

export function check(dockerfile: string, yml: string): string[] {
  const problems: string[] = [];
  const froms = dockerNodeFroms(dockerfile);
  const ci = ciNodeVersions(yml);
  if (froms.length === 0) problems.push('apps/web/Dockerfile: no FROM names the Node image (renamed? this guard must follow it)');
  if (ci.length === 0) problems.push('ci.yml: no node-version found (a removed setup-node step? this guard must follow it)');
  for (const f of froms) {
    if (!f.version) problems.push(`apps/web/Dockerfile:${f.line}: «${f.image}» is not an exact version (node:X.Y.Z-…)`);
    if (!f.digest) problems.push(`apps/web/Dockerfile:${f.line}: «${f.image}» has no @sha256 digest`);
  }
  const refs = new Set(froms.map((f) => f.image));
  if (refs.size > 1) problems.push(`apps/web/Dockerfile: the Node FROM lines differ (${[...refs].join(' · ')}) — base and runner must be one image`);
  const shipped = froms.find((f) => f.version)?.version ?? null;
  for (const c of ci) {
    if (!/^\d+\.\d+\.\d+$/.test(c.value)) problems.push(`ci.yml:${c.line}: node-version «${c.value}» is not an exact version`);
    else if (shipped && c.value !== shipped) problems.push(`ci.yml:${c.line}: node-version ${c.value} ≠ apps/web/Dockerfile ${shipped} — tested ≠ shipped`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = check(readFileSync(DOCKERFILE, 'utf8'), readFileSync(CI_YML, 'utf8'));
  const froms = dockerNodeFroms(readFileSync(DOCKERFILE, 'utf8'));
  const ci = ciNodeVersions(readFileSync(CI_YML, 'utf8'));
  if (problems.length) {
    console.error(`verify:node-version-matches-ci — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('Move apps/web/Dockerfile (both FROM · tag and digest) and every ci.yml node-version together.');
    process.exit(1);
  }
  console.log(`verify:node-version-matches-ci — OK: Dockerfile ${froms.length} FROM · ci.yml ${ci.length} node-version · all ${froms[0]!.version}`);
}
