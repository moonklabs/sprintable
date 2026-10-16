import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// story #4661 — the phone bridge has one definition in the source: the file that defines the shell's answer door
// (`page_hidden`). A second definition is a second bridge with its own state, and only one of them gets the handle.
const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('phone bridge definition (story #4661)', () => {
  it('only lib/phone-bridge.ts defines the bridge answer code (page_hidden)', () => {
    const defining = walk(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes("'page_hidden'"))
      .map((file) => relative(SRC, file));
    expect(defining).toEqual(['lib/phone-bridge.ts']);
  });

  // story #4661 — the bridge is imported in one place: the claim (it hands the state to every screen through the context).
  it("only the claim imports '@/lib/phone-bridge' (every screen reads the context)", () => {
    const importing = walk(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes("'@/lib/phone-bridge'"))
      .map((file) => relative(SRC, file));
    expect(importing).toEqual(['components/providers/phone-bridge-claim.tsx']);
  });
});
