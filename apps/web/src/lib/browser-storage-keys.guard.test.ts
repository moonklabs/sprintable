// story #4487 — the browser storage list (browser-storage-keys.ts) stays complete, so a sign-out cannot miss a key nobody
// classified: every source file that calls a storage method in any form (`.setItem(` · `.removeItem(` · `.getItem(` — on
// `localStorage` / `sessionStorage`, an alias, an injected `storage?.`) is named in the list (Kadir 4902 · PO 04:42Z), and every
// key it spells (a string or the fixed head of a template given to the method · a constant passed to it · a `*KEY` / `*PREFIX`
// constant · what a `*Key()` helper returns) matches an entry. A new key fails here until it is given a scope (account → cleared
// on sign-out · kept → stays with the device).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_STORAGE_KEYS } from './browser-storage-keys';

const SRC = path.resolve(__dirname, '..');
const CALL = /\.(?:getItem|setItem|removeItem)\(/;

/** Files whose `.setItem(` / `.removeItem(` / `.getItem(` are not a key of their own — with why. */
const NOT_A_KEY_OWNER: Record<string, string> = {
  'lib/browser-storage-keys.ts': 'the clearer itself: it removes the keys the list names',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
/** Values a `*KEY` constant spells that are not storage keys — with why. */
const NOT_A_STORAGE_KEY: Record<string, string> = {
  'preset.marketing.blog_article': 'lib/desktop-setup.ts DEFAULT_SETUP_RECIPE_KEY — a recipe id sent to the server, never stored',
};

const users = sourceFiles(SRC).filter((f) => CALL.test(fs.readFileSync(f, 'utf8')) && !(rel(f) in NOT_A_KEY_OWNER));

/** Key spellings in a file that uses the storage API. Template heads before the first `${` · empty heads are skipped. */
function spelledKeys(text: string): string[] {
  const out = new Set<string>();
  // a string or template given straight to a storage method (any receiver — an alias · an injected `storage?.`)
  for (const m of text.matchAll(/\.(?:getItem|setItem|removeItem)\(\s*(['"`])([^'"`$]*)/g)) if (m[2]) out.add(m[2]);
  // a constant given to a storage method: `storage?.setItem(ACTIVE_SETUP, …)` → that constant's value in this file
  for (const m of text.matchAll(/\.(?:getItem|setItem|removeItem)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/g)) {
    const def = text.match(new RegExp(`const\\s+${m[1]}\\s*(?::[^=]+)?=\\s*(['"\`])([^'"\`$]*)`));
    if (def?.[2]) out.add(def[2]);
  }
  // `const SOME_KEY = '...'` · `const X_PREFIX = '...'` · `const fooKey = '...'` (string or template head)
  for (const m of text.matchAll(/const\s+([A-Za-z0-9_]*(?:KEY|PREFIX|Key))\s*=\s*(['"`])([^'"`$]*)/g)) if (m[3]) out.add(m[3]);
  // `function fooKey(...) { return `head${...}` }`
  for (const m of text.matchAll(/function\s+[A-Za-z0-9_]*Key\s*\([^)]*\)[^{]*\{\s*return\s+(['"`])([^'"`$]*)/g)) if (m[2]) out.add(m[2]);
  // `useMemo(() => `head${...}`` and `storageKey: 'x'` passed to the panel hook
  for (const m of text.matchAll(/storageKey:\s*(['"`])([^'"`$]*)/g)) if (m[2]) out.add(m[2]);
  for (const m of text.matchAll(/StorageKey\s*=\s*useMemo\(\(\)\s*=>\s*(['"`])([^'"`$]*)/g)) if (m[2]) out.add(m[2]);
  return [...out];
}

// a prefix entry covers keys that start with it · any other entry only its exact key (a short head never passes for a longer key)
const known = (key: string) => BROWSER_STORAGE_KEYS.some((e) => (e.prefix ? key.startsWith(e.key) : key === e.key));

describe('[SID:4487] every browser storage key has a scope', () => {
  it('found the storage users (the scan works)', () => {
    expect(users.length).toBeGreaterThan(20);
  });

  it.each(users.map(rel))('%s is named in the list', (file) => {
    expect(BROWSER_STORAGE_KEYS.some((e) => e.where.includes(file)), `add ${file}'s keys to lib/browser-storage-keys.ts with a scope`).toBe(true);
  });

  it.each(users.map(rel))('every key %s spells is in the list', (file) => {
    const unknown = spelledKeys(fs.readFileSync(path.join(SRC, file), 'utf8')).filter((k) => !known(k) && !(k in NOT_A_STORAGE_KEY));
    expect(unknown, `${file}: give these keys a scope in lib/browser-storage-keys.ts`).toEqual([]);
  });

  it('every allow-listed non-owner file still exists and still calls a storage method', () => {
    for (const f of Object.keys(NOT_A_KEY_OWNER)) expect(CALL.test(fs.readFileSync(path.join(SRC, f), 'utf8')), f).toBe(true);
  });

  it('every file the list names exists (no stale entries)', () => {
    const missing = [...new Set(BROWSER_STORAGE_KEYS.flatMap((e) => e.where))].filter((f) => !fs.existsSync(path.join(SRC, f)));
    expect(missing).toEqual([]);
  });

  it('the reader itself: a new key in a known file is caught (positive control)', () => {
    expect(spelledKeys("localStorage.setItem('brand-new-key', '1')").filter((k) => !known(k))).toEqual(['brand-new-key']);
    expect(spelledKeys('const DRAFT_KEY = `sprintable:new-thing:`;').filter((k) => !known(k))).toEqual(['sprintable:new-thing:']);
    expect(spelledKeys("function draftKey(id: string) { return `zzz:${id}`; }").filter((k) => !known(k))).toEqual(['zzz:']);
    expect(spelledKeys("const PREFIX = 'docs:zzz:';").filter((k) => !known(k))).toEqual(['docs:zzz:']);
    // an alias and an injected store (Kadir 4902)
    expect(spelledKeys("const s = window.localStorage; s.setItem('alias-key', '1');").filter((k) => !known(k))).toEqual(['alias-key']);
    expect(spelledKeys("const ACTIVE = 'injected-key'; storage?.setItem(ACTIVE, v);").filter((k) => !known(k))).toEqual(['injected-key']);
    // a short head is not a longer entry's key
    expect(known('sprintable_')).toBe(false);
    expect(known('docs:')).toBe(false);
  });
});
