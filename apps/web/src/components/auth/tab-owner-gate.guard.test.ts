// story #4490 (PO 05:00Z ②) — the owner check is not kept by hand: every layout or page that reads the session renders
// <TabOwnerGate>, itself or through a layout above it, and onboarding (which writes a person's drafts without reading the
// session itself) has its own gated layout. A new session layout without the gate fails here.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(__dirname, '../../app');
const READS_SESSION = /getServerSession\(/;
const RENDERS_GATE = /<TabOwnerGate\b/;

/** Session readers that need no gate — with why. */
const NO_GATE_NEEDED: Record<string, string> = {
  'page.tsx': 'the root page only redirects (to /today or /login) — it renders nothing',
  'invite/accept/page.tsx': 'renders the invite card only (no account-scope storage user · table 05:02Z); accepting navigates into the gated app',
};
/** Places that must render the gate even though they do not read the session themselves. */
const MUST_GATE = ['onboarding/layout.tsx'];

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) routeFiles(full, out);
    else if (/^(page|layout)\.tsx$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => path.relative(APP, f).split(path.sep).join('/');
const read = (f: string) => fs.readFileSync(f, 'utf8');

/** Whether `file` or a layout.tsx in a folder above it (inside app/) renders the gate. */
function gated(file: string): boolean {
  if (RENDERS_GATE.test(read(file))) return true;
  let dir = path.dirname(file);
  for (;;) {
    const layout = path.join(dir, 'layout.tsx');
    if (layout !== file && fs.existsSync(layout) && RENDERS_GATE.test(read(layout))) return true;
    if (dir === APP) return false;
    dir = path.dirname(dir);
  }
}

const readers = routeFiles(APP).filter((f) => READS_SESSION.test(read(f)));

describe('[SID:4490] every signed-in screen checks the browser owner first', () => {
  it('found the session readers (the scan works)', () => {
    expect(readers.length).toBeGreaterThanOrEqual(5);
  });

  it.each(readers.map(rel))('%s renders TabOwnerGate (itself or a layout above)', (file) => {
    if (file in NO_GATE_NEEDED) return;
    expect(gated(path.join(APP, file)), `${file} reads the session: render <TabOwnerGate userId={session.user_id}> (or add it to NO_GATE_NEEDED with why)`).toBe(true);
  });

  it.each(MUST_GATE)('%s renders TabOwnerGate', (file) => {
    expect(RENDERS_GATE.test(read(path.join(APP, file)))).toBe(true);
  });

  it('every no-gate exception still exists and still reads the session (no stale allowances)', () => {
    for (const f of Object.keys(NO_GATE_NEEDED)) expect(READS_SESSION.test(read(path.join(APP, f))), f).toBe(true);
  });

  it('the reader itself: a layout under a gated folder passes · a new top-level session layout fails (positive control)', () => {
    expect(gated(path.join(APP, '(authenticated)/[ws]/[proj]/layout.tsx'))).toBe(true);
    expect(gated(path.join(APP, 'login/page.tsx'))).toBe(false);
  });
});
