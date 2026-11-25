// story 5024 (AC4) — on a workspace SERVER HOST the sidebar's /desktop entry is «에이전트 연결» (the screen is where agents are attached to THIS server), not «데스크톱 앱»; everywhere else it is what it was.
// The sidebar's name and the screen's title are one word (verify-nav-label-matches-title) — checked here for the server-host pair, in both languages.
import { afterEach, describe, expect, it } from 'vitest';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';
import { resolveNavGroups } from './nav-config';
import { readNavV3FlagsFromEnv } from './nav-v3-flags-server';

const desktopItem = (flags: Parameters<typeof resolveNavGroups>[0]) => resolveNavGroups(flags).flatMap((g) => g.items).find((i) => i.id === 'desktop-app');
const base = { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false, desktopDownloadEnabled: true };

describe('[SID:5024 AC4] the sidebar entry of /desktop', () => {
  it('a server host: «에이전트 연결» (its own label and line) · any other server: «데스크톱 앱», unchanged', () => {
    expect(desktopItem({ ...base, serverHost: true })).toMatchObject({ labelKey: 'serverHostAgents', descriptionKey: 'descServerHostAgents', path: '/desktop' });
    expect(desktopItem({ ...base })).toMatchObject({ labelKey: 'desktopApp', descriptionKey: 'descDesktopApp', path: '/desktop' });
    expect(desktopItem({ ...base, serverHost: false })).toMatchObject({ labelKey: 'desktopApp' });
  });
  it('no entry at all when the screen is not there (the flag that was already the rule)', () => {
    expect(desktopItem({ ...base, desktopDownloadEnabled: false, serverHost: true })).toBeUndefined();
  });
  it('the sidebar name and the screen title are the same word, in ko and en', () => {
    for (const m of [koMessages, enMessages] as Array<{ nav: Record<string, string>; desktop: Record<string, string> }>) {
      expect(m.nav['serverHostAgents']).toBe(m.desktop['pageTitleServerHost']);
      expect(m.nav['serverHostAgents']).toBeTruthy();
      expect(m.nav['descServerHostAgents']).toBeTruthy();
    }
  });
});

describe('[SID:5024 AC4] the server reads the flag from its own environment', () => {
  const KEYS = ['SPRINTABLE_EMBEDDED', 'SPRINTABLE_PUBLIC_ORIGIN'] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  it('serverHost is true on a workspace server host (embedded + a public address) and false anywhere else', () => {
    process.env['SPRINTABLE_EMBEDDED'] = '1'; process.env['SPRINTABLE_PUBLIC_ORIGIN'] = 'https://team.example.com';
    expect(readNavV3FlagsFromEnv().serverHost).toBe(true);
    delete process.env['SPRINTABLE_PUBLIC_ORIGIN']; // the desktop app's own server
    expect(readNavV3FlagsFromEnv().serverHost).toBe(false);
    delete process.env['SPRINTABLE_EMBEDDED']; // hosted
    expect(readNavV3FlagsFromEnv().serverHost).toBe(false);
  });
});
