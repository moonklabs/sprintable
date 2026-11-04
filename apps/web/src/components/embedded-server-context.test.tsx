// @vitest-environment jsdom
//
// story 4832 — «this page is served by the desktop app's own (embedded) server»: false everywhere unless the authenticated layout says so. The layout reads the server's env once per
// request and passes it to the dashboard shell, which provides it to every client component below (`useEmbeddedServer()`).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmbeddedServerProvider, useEmbeddedServer } from './embedded-server-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const Probe = () => <p data-testid="probe">{String(useEmbeddedServer())}</p>;
const read = () => container.querySelector('[data-testid=probe]')?.textContent;

describe('[SID:4832] useEmbeddedServer', () => {
  it('false outside any provider (a page not under the authenticated layout, a test: the hosted behaviour)', async () => {
    await act(async () => { root.render(<Probe />); });
    expect(read()).toBe('false');
  });
  it('the provider\'s value, and the nearest provider wins', async () => {
    await act(async () => { root.render(<EmbeddedServerProvider embedded><Probe /></EmbeddedServerProvider>); });
    expect(read()).toBe('true');
    await act(async () => { root.render(<EmbeddedServerProvider embedded><EmbeddedServerProvider embedded={false}><Probe /></EmbeddedServerProvider></EmbeddedServerProvider>); });
    expect(read()).toBe('false');
  });
});

describe('[SID:4832] where it comes from', () => {
  const src = (...p: string[]) => readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');
  it('the layout reads the server marker and hands it to the shell; the shell provides it around its whole tree (a dropped hand is a red test)', () => {
    const layout = src('app', '(authenticated)', 'layout.tsx');
    expect(layout).toContain('embedded={isEmbeddedServer()}');
    expect(layout).toContain("import { isEmbeddedServer } from '@/lib/embedded-api-origin';");
    const shell = src('app', 'dashboard', 'dashboard-shell.tsx');
    expect(shell).toContain('embedded = false,');
    expect(shell).toMatch(/<EmbeddedServerProvider embedded=\{embedded\}>\n\s*<DashboardCtx\.Provider/);
    expect(shell).toMatch(/<\/DashboardCtx\.Provider>\n\s*<\/EmbeddedServerProvider>/);
  });
});
