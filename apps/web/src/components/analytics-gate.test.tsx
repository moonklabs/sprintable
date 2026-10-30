// story 4822 — the gate is the only place that mounts the usage-record tag: switch off → nothing is mounted, so no script, no gtag, no request; the root
// layout mounts the gate and nothing else (a direct <GoogleAnalytics /> there would walk around the switch).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }));
vi.mock('@/components/google-analytics', () => ({ GoogleAnalytics: function GoogleAnalyticsMarker() { return null; } }));

import { connection } from 'next/server';
import { GoogleAnalytics } from '@/components/google-analytics';
import { AnalyticsGate } from './analytics-gate';

const saved = process.env.DISABLE_ANALYTICS;
beforeEach(() => { delete process.env.DISABLE_ANALYTICS; vi.mocked(connection).mockClear(); });
afterEach(() => { if (saved === undefined) delete process.env.DISABLE_ANALYTICS; else process.env.DISABLE_ANALYTICS = saved; });

describe('AnalyticsGate', () => {
  it('switch unset → the tag component is mounted', async () => {
    const out = await AnalyticsGate();
    expect(out).not.toBeNull();
    expect((out as { type: unknown }).type).toBe(GoogleAnalytics);
  });

  it.each(['true', '1', 'yes', 'on', 'ture'])('DISABLE_ANALYTICS=%s → nothing is mounted', async (v) => {
    process.env.DISABLE_ANALYTICS = v;
    expect(await AnalyticsGate()).toBeNull();
  });

  it.each(['false', '0', 'no', 'off', ''])('DISABLE_ANALYTICS=%s → the tag is mounted as built', async (v) => {
    process.env.DISABLE_ANALYTICS = v;
    expect(await AnalyticsGate()).not.toBeNull();
  });

  it('the answer is asked on every request (the gate waits for the request, so a build cannot freeze it)', async () => {
    await AnalyticsGate();
    await AnalyticsGate();
    expect(connection).toHaveBeenCalledTimes(2);
    process.env.DISABLE_ANALYTICS = 'true';
    expect(await AnalyticsGate()).toBeNull();
    delete process.env.DISABLE_ANALYTICS;
    expect(await AnalyticsGate()).not.toBeNull();
  });
});

describe('the root layout', () => {
  const layout = readFileSync(join(__dirname, '..', 'app', 'layout.tsx'), 'utf8');

  it('mounts the gate', () => {
    expect(layout).toMatch(/import \{ AnalyticsGate \} from '@\/components\/analytics-gate';/);
    expect(layout).toMatch(/<AnalyticsGate \/>/);
  });

  it('does not mount the tag itself (that would walk around the switch)', () => {
    expect(layout).not.toMatch(/<GoogleAnalytics\b/);
    expect(layout).not.toMatch(/from '@\/components\/google-analytics'/);
  });
});

describe('no other file mounts the tag', () => {
  it('<GoogleAnalytics /> appears in the gate only (outside tests)', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const root = join(__dirname, '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        if (/<GoogleAnalytics\b/.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(hits).toEqual(['components/analytics-gate.tsx']);
  });
});
