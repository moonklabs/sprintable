// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SupportLauncherClearance } from './support-launcher-clearance';
import { SUPPORT_LAUNCHER_ATTR } from './support-widget-launcher';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => { root?.unmount(); }); host?.remove(); root = null; host = null; });

describe('SupportLauncherClearance — the composer keeps the support button\'s corner free (story 4906)', () => {
  it('holds its children in a non-shrinking box that gives 64px (pr-16) on the right ONLY while <html data-support-launcher> is set', async () => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<SupportLauncherClearance><button type="button">Send</button></SupportLauncherClearance>); });
    const box = host.querySelector('[data-testid="support-launcher-clearance"]') as HTMLElement;
    expect(box.querySelector('button')?.textContent).toBe('Send');
    const cls = box.className.split(/\s+/);
    // the literal Tailwind reads: the launcher's attribute is the condition — no attribute (onboarding done), no padding
    expect(cls).toContain('[:root[data-support-launcher]_&]:pr-16');
    expect(cls).toContain('shrink-0');
    expect(cls.some((c) => /^p[rx]?-\d+$/.test(c) || /^px-/.test(c))).toBe(false);          // never an unconditional padding
    // the condition is the launcher's own attribute (one name, not two)
    expect(SUPPORT_LAUNCHER_ATTR).toBe('data-support-launcher');
    expect(cls.join(' ')).toContain(`[:root[${SUPPORT_LAUNCHER_ATTR}]_&]:`);
  });

  it('64px = the 48px button + its 16px offset from the window edge (the corner the button reaches into)', async () => {
    const src = (await import('../support-widget/support-widget-launcher.tsx?raw')).default as string;
    const dock = (await import('../nav/bottom-dock.tsx?raw')).default as string;
    expect(src).toContain('h-12 w-12');                    // 48px
    expect(dock).toMatch(/fixed right-4 /);                // 16px from the right edge
    expect(dock).toContain('bottom-[calc(var(--bottom-dock-inset)+1rem)]');
  });
});

describe('the launcher marks <html> before the first paint (story 4906, codex)', () => {
  it('⭐the mark is set in a LAYOUT effect — a passive effect would let one frame paint the button on [Send] with no clearance yet', async () => {
    const src = (await import('./support-widget-launcher.tsx?raw')).default as string;
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!launcherShown\) return undefined;\s*const html = document\.documentElement;\s*html\.setAttribute\(SUPPORT_LAUNCHER_ATTR, ''\);/);
    expect(src).not.toMatch(/useEffect\(\(\) => \{\s*if \(!launcherShown\) return undefined;/);
  });
});

describe('the composers that reach the window\'s bottom-right corner sit inside the clearance (story 4906)', () => {
  it('chat room: <ChatInput> is the clearance box\'s child', async () => {
    const src = (await import('../chat/chat-view.tsx?raw')).default as string;
    expect(src).toContain("from '@/components/support-widget/support-launcher-clearance'");
    expect(src).toMatch(/<SupportLauncherClearance>\s*<ChatInput\b/);
  });

  it('thread panel: <ChatInput> is the clearance box\'s child', async () => {
    const src = (await import('../chat/thread-panel.tsx?raw')).default as string;
    expect(src).toContain("from '@/components/support-widget/support-launcher-clearance'");
    expect(src).toMatch(/<SupportLauncherClearance>\s*<ChatInput\b/);
  });
});
