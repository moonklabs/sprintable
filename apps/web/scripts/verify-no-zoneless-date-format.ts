/**
 * story #4443 PR2a — a ratchet on dates drawn without a named time zone (PO 23:15Z). One screen showed two zones: «연결된 기기»
 * in next-intl's (nothing set it: the server's UTC) and the chat bubble in the browser's. The rule (PO 22:38Z): when something
 * happened is drawn in the viewer's zone (components/viewer-time-zone.tsx · lib/viewer-time-zone.ts), a team date in the org's.
 * Either way the zone is named — never the runtime's by accident (the server's UTC in a server render, the browser's after).
 *
 *   ① zoneless-intl  : `Intl.DateTimeFormat(…)` or next-intl's `format.dateTime(…)` whose arguments (read to the closing parenthesis, over lines) name no `timeZone`
 *   ② fixed-locale   : a date format in a hard-coded Korean locale (`Intl.DateTimeFormat('ko-KR'` · `'ko'`) — the viewer's locale
 *                      decides (Yuna 22:45Z: ko «오전 7:18» · en «7:18 AM»)
 *   ③ no-arg-display-tz : `resolveDisplayTimezone()` with no argument — the runtime's zone (PR2b moves these to the viewer's)
 *   ④ fixed-zone     : a place's zone written as a literal (`timeZone: 'Asia/Seoul'`) — a team date is the org's zone, not one
 *                      city's (PR3). `'UTC'` is not counted: it is how a calendar-day key or an offset label is drawn on purpose.
 * Not counted: `Intl.DateTimeFormat().resolvedOptions()` — that asks the runtime which zone it is in (how the viewer's zone is
 * found), it draws nothing. Dates through `toLocale*String` are already held at 0 by verify:no-date-tolocalestring.
 *
 * baseline-freeze (the house ratchet, verify-no-member-name-fallback.ts): what is left is frozen with a reason in
 * zoneless-date-format-baseline.json; a new place fails, and a frozen place that is gone fails too (take its line out — the
 * ratchet only goes down). Keys are file + kind + the line's text (not its number: an unrelated line above must not break it);
 * the same text twice in a file gets «#2». `--print` writes the current places as a baseline (to measure at a PR's head).
 *
 * Not seen (declared): a formatter built from a variable holding the options (`new Intl.DateTimeFormat(locale, opts)` counts as
 * zoneless — name the zone at the call); date-fns and the like (none in src today). Test files are not read.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../src');
const BASELINE_PATH = path.resolve(HERE, 'zoneless-date-format-baseline.json');
const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.test\.(tsx?|jsx?)$/;
// the definition itself (its fallback is what ③ counts at the call sites)
const DEFINITION_FILES = new Set(['components/content/schedule-format.ts']);

export type ZonelessKind = 'zoneless-intl' | 'fixed-locale' | 'no-arg-display-tz' | 'fixed-zone';

export interface ZonelessHit { kind: ZonelessKind; file: string; line: number; snippet: string; key: string }

/** The call's argument text from the opening parenthesis to its match (strings and nested brackets respected enough for code). */
function argsFrom(content: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return content.slice(open + 1, i); }
  }
  return content.slice(open + 1);
}

const lineOf = (content: string, index: number) => content.slice(0, index).split('\n').length;

export function findZonelessDates(content: string, file: string): ZonelessHit[] {
  const lines = content.split('\n');
  const raw: Omit<ZonelessHit, 'key'>[] = [];
  // Intl's formatter, and next-intl's (`format.dateTime(…)` — without a zone it takes the provider's, which is how «연결된 기기»
  // came to read the server's UTC)
  const intl = /Intl\.DateTimeFormat\(|\bformat(?:ter)?\.dateTime\(/g;
  for (let m = intl.exec(content); m; m = intl.exec(content)) {
    const open = m.index + m[0].length - 1;
    const args = argsFrom(content, open);
    const after = content.slice(open + args.length + 2, open + args.length + 2 + 20);
    const line = lineOf(content, m.index);
    const snippet = lines[line - 1]!.trim();
    if (args.trim() === '' && after.startsWith('.resolvedOptions()')) continue; // asks the runtime its zone — draws nothing
    if (/^\s*['"]ko(?:-KR)?['"]/.test(args)) raw.push({ kind: 'fixed-locale', file, line, snippet });
    if (!/\btimeZone\b/.test(args)) raw.push({ kind: 'zoneless-intl', file, line, snippet });
  }
  const literalZone = /\btimeZone\s*:\s*['"]([A-Za-z]+\/[A-Za-z_]+)['"]/g;
  for (let m = literalZone.exec(content); m; m = literalZone.exec(content)) {
    const line = lineOf(content, m.index);
    raw.push({ kind: 'fixed-zone', file, line, snippet: lines[line - 1]!.trim() });
  }
  if (!DEFINITION_FILES.has(file)) {
    const noArg = /\bresolveDisplayTimezone\(\s*\)/g;
    for (let m = noArg.exec(content); m; m = noArg.exec(content)) {
      const line = lineOf(content, m.index);
      const text = lines[line - 1]!.trim();
      if (text.startsWith('//') || text.startsWith('*')) continue; // a mention in a comment
      raw.push({ kind: 'no-arg-display-tz', file, line, snippet: text });
    }
  }
  const seen = new Map<string, number>();
  return raw.map((h) => {
    const base = `${h.file}::${h.kind}::${h.snippet}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...h, key: n === 1 ? base : `${base}#${n}` };
  });
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

export function scanRepository(root: string = SRC_ROOT): ZonelessHit[] {
  const files: string[] = [];
  walk(root, files);
  return files.sort().flatMap((abs) => findZonelessDates(readFileSync(abs, 'utf8'), path.relative(root, abs).split(path.sep).join('/')));
}

export interface BaselineEntry { key: string; reason: string }

export function loadBaseline(p: string = BASELINE_PATH): BaselineEntry[] {
  return JSON.parse(readFileSync(p, 'utf8')) as BaselineEntry[];
}

export function compareWithBaseline(hits: ZonelessHit[], baseline: BaselineEntry[]): { fresh: ZonelessHit[]; stale: BaselineEntry[] } {
  const keys = new Set(baseline.map((b) => b.key));
  const found = new Set(hits.map((h) => h.key));
  return { fresh: hits.filter((h) => !keys.has(h.key)), stale: baseline.filter((b) => !found.has(b.key)) };
}

export const REASONS: Record<ZonelessKind, string> = {
  'zoneless-intl': 'story #4443 — frozen at PR2a; drawn in the runtime zone → PR2b (the viewer\'s) or PR3 (a team date → the org\'s)',
  'fixed-locale': 'story #4443 — frozen at PR2a; a hard-coded Korean date locale → the viewer\'s locale',
  'no-arg-display-tz': 'story #4443 — frozen at PR2a; the runtime\'s zone → useViewerTimeZone (PR2b) · a team date → PR3',
  'fixed-zone': 'story #4443 — frozen at PR2a; one city\'s zone written in → the org\'s zone for a team date (PR3)',
};

// positive and negative controls — the guard checks itself first (a miss or a false catch fails)
export const SELF_TEST: { code: string; kinds: ZonelessKind[] }[] = [
  { code: "const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(m.created_at));", kinds: ['fixed-locale', 'zoneless-intl'] },
  { code: 'const f = new Intl.DateTimeFormat(locale, {\n  month: \'long\',\n  day: \'numeric\',\n}).format(d);', kinds: ['zoneless-intl'] },
  { code: 'return new Intl.DateTimeFormat(resolvedLocale, options).format(date);', kinds: ['zoneless-intl'] },
  { code: 'const displayTimezone = resolveDisplayTimezone().tz;', kinds: ['no-arg-display-tz'] },
  { code: 'const date = at ? format.dateTime(new Date(at), deviceDateOptions(at)) : null;', kinds: ['zoneless-intl'] },
  { code: "const date = format.dateTime(new Date(at), { ...deviceDateOptions(at), timeZone: tz ?? 'UTC' });", kinds: [] },
  { code: 'const f = new Intl.DateTimeFormat(locale, {\n  month: \'long\',\n  timeZone: tz,\n}).format(d);', kinds: [] },
  { code: 'return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);', kinds: [] },
  { code: 'return Intl.DateTimeFormat().resolvedOptions().timeZone;', kinds: [] },
  { code: 'const { tz } = resolveDisplayTimezone(orgTimezone);', kinds: [] },
  { code: '// resolveDisplayTimezone() falls back to the browser', kinds: [] },
  { code: "{e.balance.toLocaleString()} TJSB", kinds: [] },
  { code: "return new Intl.DateTimeFormat('sv-SE', {\n    timeZone: 'Asia/Seoul',\n    year: 'numeric',\n  }).format(value);", kinds: ['fixed-zone'] },
  { code: "new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric' })", kinds: [] },
];

export function runSelfTest(): string[] {
  const misses: string[] = [];
  for (const s of SELF_TEST) {
    const got = findZonelessDates(s.code, 'self-test.tsx').map((h) => h.kind).sort();
    const want = [...s.kinds].sort();
    if (got.join() !== want.join()) misses.push(`want [${want.join()}] got [${got.join()}]: ${s.code.split('\n')[0]}`);
  }
  return misses;
}

function main(): void {
  const misses = runSelfTest();
  if (misses.length > 0) {
    console.log('\nFAIL: guard self-test (positive and negative controls):');
    for (const m of misses) console.log(`  - ${m}`);
    process.exit(1);
  }
  const hits = scanRepository();
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(hits.map((h) => ({ key: h.key, reason: REASONS[h.kind] })), null, 2));
    return;
  }
  const { fresh, stale } = compareWithBaseline(hits, loadBaseline());
  if (fresh.length > 0 || stale.length > 0) {
    if (fresh.length > 0) {
      console.log(`\nFAIL: ${fresh.length} date(s) drawn without a named zone, outside the baseline — use ViewerDate / formatViewerDate (the viewer's zone) or name the org's zone for a team date:`);
      for (const h of fresh) console.log(`  - [${h.kind}] ${h.file}:${h.line} ${h.snippet}`);
    }
    if (stale.length > 0) {
      console.log(`\nFAIL: ${stale.length} baseline line(s) no longer in the source — take them out of scripts/zoneless-date-format-baseline.json (the ratchet goes down):`);
      for (const b of stale) console.log(`  - ${b.key}`);
    }
    process.exit(1);
  }
  const by = (k: ZonelessKind) => hits.filter((h) => h.kind === k).length;
  console.log(`OK: no new zoneless date — baseline ${hits.length} (zoneless-intl ${by('zoneless-intl')} · fixed-locale ${by('fixed-locale')} · no-arg-display-tz ${by('no-arg-display-tz')} · fixed-zone ${by('fixed-zone')})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
