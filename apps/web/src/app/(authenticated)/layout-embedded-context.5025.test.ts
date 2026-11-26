// story 5025 (found on the VM round) — the authenticated layout hands `useEmbeddedServer()` to every client component: it must be LOCAL MODE (`isLocalModeServer()`), not «any embedded server».
// A workspace SERVER HOST is embedded too, and with the old value the pages below said «no remote control to switch · one computer only» there (components/desktop/remote-off.tsx · the agent list · the workforce page).
// The layout is a large async server component whose other tests mock most of its world, so this holds the ONE line by its source (the repo's «original pin»), next to the predicate's own tests (lib/embedded-api-origin.test.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(__dirname, 'layout.tsx'), 'utf8');

describe('[SID:5025] the authenticated layout\'s embedded context', () => {
  it('hands local mode (isLocalModeServer) to the shell — and nothing else decides it', () => {
    expect(src).toMatch(/embedded=\{isLocalModeServer\(\)\}/);
    expect(src).toMatch(/import \{ isLocalModeServer \} from '@\/lib\/embedded-api-origin';/);
  });
  it('never hands the bare «any embedded server» (a server host would read as local mode again)', () => {
    expect(src).not.toMatch(/embedded=\{isEmbeddedServer\(\)\}/);
    expect(src).not.toMatch(/embedded=\{true\}/);
  });
});
