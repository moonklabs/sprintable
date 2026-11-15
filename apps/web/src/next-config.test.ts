/**
 * S12 AC1: next.config.ts rewrites 구조 검증
 * /api/v2/** → NEXT_PUBLIC_FASTAPI_URL/api/v2/**
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('next.config rewrites', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('proxies /api/v2/:path* to NEXT_PUBLIC_FASTAPI_URL', async () => {
    process.env.NEXT_PUBLIC_FASTAPI_URL = 'http://localhost:8000';

    const mod = await import('../next.config');
    const config = mod.default as { rewrites?: () => Promise<Array<{ source: string; destination: string }>> };

    const rules = await config.rewrites?.();
    expect(rules).toBeDefined();
    expect(rules).toHaveLength(1);
    expect(rules![0].source).toBe('/api/v2/:path*');
    expect(rules![0].destination).toBe('http://localhost:8000/api/v2/:path*');
  });

  it('falls back to http://localhost:8000 when env is unset', async () => {
    delete process.env.NEXT_PUBLIC_FASTAPI_URL;

    const mod = await import('../next.config');
    const config = mod.default as { rewrites?: () => Promise<Array<{ source: string; destination: string }>> };

    const rules = await config.rewrites?.();
    expect(rules![0].destination).toBe('http://localhost:8000/api/v2/:path*');
  });
});

describe('next.config redirects (story 4891)', () => {
  it('sends /signup to the sign-up page /register — temporarily, never a permanent redirect', async () => {
    vi.resetModules();
    const mod = await import('../next.config');
    const config = mod.default as { redirects?: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>> };
    const rules = await config.redirects?.();
    const r = rules!.find((x) => x.source === '/signup');
    expect(r).toBeDefined();
    expect(r!.destination).toBe('/register');
    expect(r!.permanent).toBe(false);
  });
});
