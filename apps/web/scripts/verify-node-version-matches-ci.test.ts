// story #4449 — verify-node-version-matches-ci: synthetic files for each RED shape, and the real repo green.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check, ciNodeVersions, dockerNodeFroms } from './verify-node-version-matches-ci';

const D = 'sha256:' + 'a'.repeat(64);
const docker = (a: string, b = a) => `FROM ${a} AS base\nRUN corepack enable pnpm\nFROM base AS builder\nRUN pnpm build\nFROM ${b} AS runner\n`;
const ci = (...v: string[]) => v.map((x) => `      - uses: actions/setup-node@v4\n        with:\n          node-version: '${x}'\n`).join('');
const PINNED = `mirror.gcr.io/library/node:22.23.3-alpine@${D}`;

describe('[SID:4449] node version: tested = shipped', () => {
  it('green: both FROM one exact pinned image, every ci node-version the same', () => {
    expect(check(docker(PINNED), ci('22.23.3', '22.23.3'))).toEqual([]);
  });

  it('a moving tag is RED (what dev shipped until now: node:20-alpine)', () => {
    const p = check(docker('mirror.gcr.io/library/node:20-alpine'), ci('22.23.3'));
    expect(p.some((x) => x.includes('not an exact version'))).toBe(true);
    expect(p.some((x) => x.includes('no @sha256 digest'))).toBe(true);
  });

  it('an exact tag without a digest is RED', () => {
    expect(check(docker('mirror.gcr.io/library/node:22.23.3-alpine'), ci('22.23.3')).join('\n')).toContain('no @sha256 digest');
  });

  it('only one side moved is RED — the ci patch (22.23.2 vs 22.23.3) and a moving ci «22»', () => {
    expect(check(docker(PINNED), ci('22.23.2')).join('\n')).toContain('22.23.2 ≠ apps/web/Dockerfile 22.23.3');
    expect(check(docker(PINNED), ci('22.23.3', '22')).join('\n')).toContain("node-version «22» is not an exact version");
  });

  it('base and runner apart is RED', () => {
    const other = `mirror.gcr.io/library/node:22.23.2-alpine@${'sha256:' + 'b'.repeat(64)}`;
    expect(check(docker(PINNED, other), ci('22.23.3')).join('\n')).toContain('the Node FROM lines differ');
  });

  it('nothing to compare is RED, not a silent pass', () => {
    expect(check('FROM python:3.12\n', ci('22.23.3')).join('\n')).toContain('no FROM names the Node image');
    expect(check(docker(PINNED), 'jobs: {}\n').join('\n')).toContain('no node-version found');
  });

  it('parsers: FROM base is not an image · --platform · quotes and comments on node-version', () => {
    expect(dockerNodeFroms(`FROM --platform=linux/amd64 ${PINNED} AS base\nFROM base AS deps\n`)).toEqual([
      { line: 1, image: PINNED, version: '22.23.3', digest: D },
    ]);
    expect(ciNodeVersions(`  node-version: "22.23.3" # pinned\n  node-version: 22.23.3\n`).map((c) => c.value)).toEqual(['22.23.3', '22.23.3']);
  });

  it('the real repo: apps/web/Dockerfile and ci.yml agree', () => {
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const dockerfile = readFileSync(path.join(web, 'Dockerfile'), 'utf8');
    const yml = readFileSync(path.join(web, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(check(dockerfile, yml)).toEqual([]);
    expect(dockerNodeFroms(dockerfile)).toHaveLength(2);
    expect(ciNodeVersions(yml).length).toBeGreaterThanOrEqual(2);
  });
});
