import { describe, expect, it } from 'vitest';
import { isPanelId, isPanelPath } from './panel-path';

describe('[SID:5042] the desktop app\'s panel addresses', () => {
  it('⭐only /desktop/panel/… is a panel address — the web\'s own pages and the public /desktop/updates are not', () => {
    expect(isPanelPath('/desktop/panel/work-item/7e0e7cc1-c2b8-4669-bfaa-3b13903fd670')).toBe(true);
    for (const p of ['/desktop/panel', '/desktop', '/desktop/updates/macos.json', '/desktopx/panel/x', '/chats', '/', '/x/desktop/panel/y', '', null, undefined]) expect(isPanelPath(p as string)).toBe(false);
  });
  it('an id in a panel address is a uuid and nothing else (it goes into a request path)', () => {
    expect(isPanelId('7e0e7cc1-c2b8-4669-bfaa-3b13903fd670')).toBe(true);
    expect(isPanelId('7E0E7CC1-C2B8-4669-BFAA-3B13903FD670')).toBe(true);
    for (const v of ['', 'x', '../me', '7e0e7cc1-c2b8-4669-bfaa-3b13903fd670/x', '7e0e7cc1-c2b8-4669-bfaa-3b13903fd670?x=1', ' 7e0e7cc1-c2b8-4669-bfaa-3b13903fd670', 7, null, undefined]) expect(isPanelId(v)).toBe(false);
  });
});
