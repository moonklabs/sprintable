import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// story 5042 (C9) — the (authenticated) layout is a server component with many reads; its one panel rule is held as a source pin (a revert fails here): a panel address gets its page alone — no usage banner above, no setup watcher beside.
const layout = readFileSync(path.join(__dirname, '..', '..', 'app', '(authenticated)', 'layout.tsx'), 'utf8');
describe('[SID:5042] the layout hands a panel page to the shell alone', () => {
  it('⭐a panel address renders `children` only — the usage banner and the setup watcher are in the other branch', () => {
    const at = layout.indexOf('isPanelPath(currentPath) ? children : (');
    expect(at).toBeGreaterThan(0);
    const other = layout.slice(at);
    expect(other.indexOf('<AuUsageBanner />')).toBeGreaterThan(0);
    expect(other.indexOf('<DesktopSetupDocWatch />')).toBeGreaterThan(other.indexOf('<AuUsageBanner />'));
    // the banner and the watcher are NOT outside that branch (nowhere before it)
    expect(layout.slice(0, at)).not.toContain('<AuUsageBanner />');
    expect(layout.slice(0, at)).not.toContain('<DesktopSetupDocWatch />');
  });
});
