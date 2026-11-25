// story 5024 (AC4) — on a workspace SERVER HOST the sidebar's /desktop entry is «에이전트 연결» (the screen is where agents are attached to THIS server), not «데스크톱 앱»; everywhere else it is what it was.
// The sidebar's name and the screen's title are one word (verify-nav-label-matches-title) — checked here for the server-host pair, in both languages.
import { describe, expect, it } from 'vitest';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';
import { resolveNavGroups } from './nav-config';

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
