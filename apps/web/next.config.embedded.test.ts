// story 4824 (security lens AC8 · AC9) — the build the desktop app carries is configured by ONE build-time switch, SPRINTABLE_EMBEDDED_BUILD=1; the hosted builds never set it
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) { if (v === undefined) vi.stubEnv(k, ''); else vi.stubEnv(k, v); }
  const mod = (await import('./next.config')) as { default: { rewrites?: () => Promise<unknown>; experimental?: Record<string, unknown> } };
  return mod.default;
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('next.config — the desktop app\'s build', () => {
  it('hosted build (no switch): the /api/v2 rewrite is there, to NEXT_PUBLIC_FASTAPI_URL, and the body limit is Next\'s default (unchanged)', async () => {
    const cfg = await loadConfig({ SPRINTABLE_EMBEDDED_BUILD: '', NEXT_PUBLIC_FASTAPI_URL: 'https://api.example.com' });
    const rewrites = (await cfg.rewrites!()) as Array<{ source: string; destination: string }>;
    expect(rewrites).toEqual([{ source: '/api/v2/:path*', destination: 'https://api.example.com/api/v2/:path*' }]);
    expect(cfg.experimental?.['proxyClientMaxBodySize']).toBeUndefined();
  });

  it('SPRINTABLE_EMBEDDED_BUILD=1: NO build-time rewrite (its destination would be a baked address — a stranger\'s server on the default port), and the proxy may buffer up to the attachment limit (100 MB)', async () => {
    const cfg = await loadConfig({ SPRINTABLE_EMBEDDED_BUILD: '1', NEXT_PUBLIC_FASTAPI_URL: 'https://api.example.com' });
    expect(await cfg.rewrites!()).toEqual([]);
    expect(cfg.experimental?.['proxyClientMaxBodySize']).toBe('100mb');
  });

  it('only exactly "1" switches it on', async () => {
    for (const v of ['0', 'true', 'yes']) {
      const cfg = await loadConfig({ SPRINTABLE_EMBEDDED_BUILD: v });
      expect(((await cfg.rewrites!()) as unknown[]).length, v).toBe(1);
    }
  });
});

describe('turbo passes the build switch on (measured: without this line `pnpm build` ran next build WITHOUT it and the baked rewrite and the 10 MB limit stayed)', () => {
  it('turbo.json declares SPRINTABLE_EMBEDDED_BUILD for the build task', () => {
    const turbo = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'turbo.json'), 'utf-8')) as { tasks: { build: { env?: string[] } } };
    expect(turbo.tasks.build.env).toContain('SPRINTABLE_EMBEDDED_BUILD');
  });
});
