// story #4524 (Min's 4503 AC4 run · Yuna 04:47Z) — the sidebar's «데스크톱 앱» entry to /desktop («연결된 기기»: where a person
// disconnects a device), shown only where /desktop exists: DESKTOP_DOWNLOAD_ENABLED (server-only) — /desktop redirects when off.
import { afterEach, describe, expect, it } from 'vitest';
import { Monitor } from 'lucide-react';

import en from '../../messages/en.json';
import ko from '../../messages/ko.json';
import { NAV_GROUPS, resolveNavGroups } from './nav-config';
import { DEFAULT_NAV_V3_FLAGS } from './nav-v3-destinations';
import { readNavV3FlagsFromEnv } from './nav-v3-flags-server';

const ids = (groups: ReturnType<typeof resolveNavGroups>, groupId: string) =>
  groups.find((g) => g.id === groupId)?.items.map((i) => i.id) ?? [];

describe('story #4524 — the «데스크톱 앱» sidebar entry', () => {
  const saved = process.env.DESKTOP_DOWNLOAD_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.DESKTOP_DOWNLOAD_ENABLED;
    else process.env.DESKTOP_DOWNLOAD_ENABLED = saved;
  });

  it('on: the last item of «연결·규칙» — /desktop · org · Monitor · Yuna’s label and description keys', () => {
    const groups = resolveNavGroups({ ...DEFAULT_NAV_V3_FLAGS, desktopDownloadEnabled: true });
    const items = groups.find((g) => g.id === 'connect-rules')!.items;
    const item = items[items.length - 1];
    expect(item).toMatchObject({
      id: 'desktop-app', labelKey: 'desktopApp', descriptionKey: 'descDesktopApp', kind: 'static', path: '/desktop', scope: 'org',
    });
    expect(item.icon).toBe(Monitor);
  });

  it('off or absent: no entry anywhere (no link to a page that sends you back)', () => {
    for (const flags of [DEFAULT_NAV_V3_FLAGS, { ...DEFAULT_NAV_V3_FLAGS, desktopDownloadEnabled: false }]) {
      expect(resolveNavGroups(flags).flatMap((g) => g.items.map((i) => i.id))).not.toContain('desktop-app');
    }
  });

  it('beside the v3 overview: overview first, the existing three, then «데스크톱 앱»', () => {
    const groups = resolveNavGroups({ ...DEFAULT_NAV_V3_FLAGS, connectRulesV3Enabled: true, desktopDownloadEnabled: true });
    expect(ids(groups, 'connect-rules')).toEqual([
      'connect-rules-v3', 'org-channels', 'org-generation-connectors', 'org-content-rules', 'desktop-app',
    ]);
  });

  it('never in NAV_GROUPS itself — the command palette reads that list as is, with no flag', () => {
    expect(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))).not.toContain('desktop-app');
  });

  it('the server reads it with /desktop’s own gate: "true" on · "false" and unset off', () => {
    process.env.DESKTOP_DOWNLOAD_ENABLED = 'true';
    expect(readNavV3FlagsFromEnv().desktopDownloadEnabled).toBe(true);
    process.env.DESKTOP_DOWNLOAD_ENABLED = 'false';
    expect(readNavV3FlagsFromEnv().desktopDownloadEnabled).toBe(false);
    delete process.env.DESKTOP_DOWNLOAD_ENABLED;
    expect(readNavV3FlagsFromEnv().desktopDownloadEnabled).toBe(false);
  });

  it('Yuna’s copy, ko and en', () => {
    const nav = (m: Record<string, unknown>) => m['nav'] as Record<string, string>;
    expect([nav(ko).desktopApp, nav(ko).descDesktopApp]).toEqual(['데스크톱 앱', '이 컴퓨터에 받는 앱 · 연결된 기기']);
    expect([nav(en).desktopApp, nav(en).descDesktopApp]).toEqual(['Desktop app', 'The app for this computer · connected devices']);
  });
});
