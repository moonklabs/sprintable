#!/usr/bin/env node
// [SID:4836] THIRD_PARTY_NOTICES.md, made from the lockfiles (pnpm-lock.yaml and the two uv.lock) — never written by hand.
//   node scripts/third-party-notices.js            write THIRD_PARTY_NOTICES.md (needs every locked package in the licence cache)
//   node scripts/third-party-notices.js --check    exit 1 if the committed file is not what the lockfiles + cache give (the test asserts the same equality)
//   node scripts/third-party-notices.js --refresh  ask the package registries for the licence of every locked version that the cache lacks, then write
// Inputs: the lockfiles listed in LOCKS and UV_LOCKS, the cache scripts/third-party-notices.licenses.json
// (the registry's own licence value per package@version — one network step, `--refresh`), the manual entries below (libraries no lockfile lists) and the overrides (a registry value
// that is empty or ambiguous, read by hand from the upstream licence file, with the reason). Same inputs, same bytes: no clock, no machine path, sorted.
// It also holds the line «no dependency conflicts with a permissive release»: a licence that ranks as a conflict (GPL / AGPL / SSPL / BUSL / non-commercial / proprietary) or that nobody
// has read (rank 2, no override) stops the run.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { parse: parseToml } = require('smol-toml');

const ROOT = path.resolve(__dirname, '..');
const OUT = 'THIRD_PARTY_NOTICES.md';
const CACHE = 'scripts/third-party-notices.licenses.json';
/** the lockfiles of this repository: the pnpm workspace's, and the two Python services' */
const LOCKS = ['pnpm-lock.yaml'];
const UV_LOCKS = ['backend/uv.lock', 'support-gateway/uv.lock'];
/** libraries that no lockfile lists (none here: the container base images are not lockfile entries — see the note in the file) */
const MANUAL = [];
/** a registry value that is empty or ambiguous, read from the upstream licence file by hand: key → { license, why } */
/** what the file does not cover, stated in the file */
const SCOPE_NOTE = 'Operating-system packages inside the container images are not lockfile entries and are not listed.';
const OVERRIDES = {
  'npm:khroma@2.1.0': { license: 'MIT', why: 'the npm package declares no licence; its upstream repository (fabiospampinato/khroma) carries an MIT licence file' },
  'pypi:google-crc32c@1.8.0': { license: 'Apache-2.0', why: 'PyPI declares no licence; its upstream repository (googleapis/python-crc32c) carries an Apache-2.0 licence file' },
  'pypi:lupa@2.8': { license: 'MIT', why: 'PyPI declares «MIT style»; the licence file of the upstream repository (scoder/lupa, LICENSE.txt) is the MIT text' },
  'pypi:pytest-timeout@2.4.0': { license: 'MIT', why: 'PyPI lists the classifiers «DFSG approved» and «MIT License»; the upstream repository (pytest-dev/pytest-timeout) carries an MIT licence file' },
  'pypi:hyperframe@6.1.0': { license: 'MIT', why: 'PyPI gives the MIT classifier and the licence text pasted into the licence field; the upstream licence file (python-hyper/hyperframe, LICENSE) is the MIT text' },
  'pypi:python-dateutil@2.9.0.post0': { license: 'Apache Software License OR BSD License', why: 'PyPI lists both classifiers and the text «Dual License»; the upstream licence file (dateutil/dateutil, LICENSE) is Apache-2.0 for the current code with the older BSD terms kept for earlier contributions' },
  'pypi:psycopg2-binary@2.9.12': { license: 'GNU Library or Lesser General Public License (LGPL)', why: 'PyPI gives the LGPL classifier and the text «LGPL with exceptions»; the upstream licence file (psycopg/psycopg2, LICENSE) is the LGPL, version 3 or later, with the linking exceptions' },
  'pypi:pgvector@0.4.2': { license: 'MIT', why: 'PyPI declares no licence; its upstream repository (pgvector/pgvector-python) carries an MIT licence file' },
};

// ---- licence ranking: 0 permissive · 1 notice duty (weak copyleft, fonts, …) · 2 nobody has read it · 3 conflict with a permissive release ----
// Fail closed, by an allowlist: a value ranks 0 or 1 ONLY when its whole text is a name listed here (or an OR / AND / parenthesised combination of such names). Everything else — a name not
// listed, an unbalanced parenthesis, a «WITH» exception not listed, free text — is 2 (or 3 when a copyleft / non-commercial / proprietary word is in it): both stop the run until a person reads it.
const PERMISSIVE = new Set(['mit', 'isc', 'apache-2.0', 'apache 2.0', '0bsd', 'unlicense', 'cc0-1.0', 'bsd', 'bsd-2-clause', 'bsd-3-clause', 'bsd-3-clause-clear', 'bsd-2-clause-patent', 'zlib', 'blueoak-1.0.0', 'python-2.0', 'psf-2.0', 'psf', 'mit-0', 'mit-cmu', 'x11', 'ncsa', 'postgresql', 'hpnd', 'bsl-1.0', 'unicode-3.0', 'unicode-dfs-2016', 'cc-by-3.0', 'cc-by-4.0', 'public domain', 'wtfpl', 'apache software license', 'mit license', 'bsd license', 'the unlicense', 'isc license', 'python software foundation license', 'zope public license', 'zpl-2.1', 'the apache software license, version 2.0', 'apache license, version 2.0', 'apache license 2.0', '3-clause bsd license']);
const NOTICE = new Set(['mpl-1.1', 'mpl-2.0', 'lgpl-2.0-only', 'lgpl-2.0-or-later', 'lgpl-2.1-only', 'lgpl-2.1-or-later', 'lgpl-3.0-only', 'lgpl-3.0-or-later', 'epl-1.0', 'epl-2.0', 'cddl-1.0', 'cddl-1.1', 'ofl-1.1', 'artistic-2.0', 'mozilla public license 2.0 (mpl 2.0)', 'gnu library or lesser general public license (lgpl)', 'gnu lesser general public license v3 or later (lgplv3+)', 'gnu lesser general public license v2 or later (lgplv2+)']);
/** the licence exceptions known to be harmless to a permissive release (the base licence keeps its rank); any other «WITH …» is read by hand */
/** the free-text copyleft names the registries use (PyPI classifiers): the only multi-word copyleft values that count as a recognised choice inside an OR */
const CONFLICT_NAMES = new Set(['gnu general public license v2 (gplv2)', 'gnu general public license v2 or later (gplv2+)', 'gnu general public license v3 (gplv3)', 'gnu general public license v3 or later (gplv3+)', 'gnu affero general public license v3', 'gnu affero general public license v3 or later (agplv3+)']);
/** the copyleft licence IDs that count as a recognised choice inside an OR (exact SPDX ids with their real versions: «GPL-bogus» or a bare «GPL» is not one); any other token that merely looks like a conflict («Proprietary», «non-commercial») is not a choice but unread text */
const CONFLICT_ID = /^(?:gpl-(?:1\.0|2\.0|3\.0)|agpl-(?:1\.0|3\.0))(?:-only|-or-later|\+)?$|^sspl-1\.0$|^busl-1\.1$|^cc-by-nc(?:-(?:nd|sa))?-(?:1\.0|2\.0|2\.5|3\.0|4\.0)$|^cc-by-nd-(?:1\.0|2\.0|2\.5|3\.0|4\.0)$/i;
const SAFE_EXCEPTIONS = new Set(['llvm-exception']);
/** words that make a value a conflict (3) rather than merely unread (2); this list only picks the message — the allowlist above is what lets a value through */
const CONFLICT_RX = /gpl|sspl|busl|business source|commons clause|elastic|proprietary|unlicensed|cc-by-nc|cc-by-nd|non[- ]?commercial|confluent|polyform|all rights reserved|gnu general|gnu affero/;

/** one name: 0 / 1 when listed, else 3 / 2 */
function rankAtom(atom) {
  const t = atom.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!t) return 2;
  if (PERMISSIVE.has(t)) return 0;
  if (NOTICE.has(t)) return 1;
  const m = /^(.*?) with (.+)$/.exec(t); // «Apache-2.0 WITH LLVM-exception»: the base must be listed and the exception too; a conflict base with an exception is read by hand
  if (m) {
    const base = PERMISSIVE.has(m[1]) ? 0 : NOTICE.has(m[1]) ? 1 : null;
    if (base !== null && SAFE_EXCEPTIONS.has(m[2])) return base;
    return 2;
  }
  return CONFLICT_RX.test(t.replace(/lgpl/g, '')) ? 3 : 2;
}

/** SPDX-ish expressions and the registries' free-text forms: OR → the best side, AND → the worst; a whole-text name is tried first (some names hold spaces and parentheses) */
function rank(expr) {
  if (expr === null || expr === undefined) return 2;
  const s = String(expr).trim();
  if (!s || /^(unknown|none|n\/a)$/i.test(s) || /^see license/i.test(s)) return 2;
  const whole = rankAtom(s);
  if (whole !== 2 && whole !== 3) return whole; // an exact listed name
  let pos = 0;
  let sawUnread = false; // an operand nobody has read (rank 2) makes the whole value unread: «MIT OR Foo» is not recognised just because one side is
  const peekOp = () => /^ +(OR|AND) +/.exec(s.slice(pos));
  const atomEnd = (depth) => { for (let i = pos; i < s.length; i++) { if (s[i] === ')' && depth > 0) return i; if (/^ +(OR|AND) +/.test(s.slice(i))) return i; } return s.length; };
  function parseOr(depth) { let v = parseAnd(depth); for (let o = peekOp(); o && o[1] === 'OR'; o = peekOp()) { pos += o[0].length; v = Math.min(v, parseAnd(depth)); } return v; }
  function parseAnd(depth) { let v = parseAtom(depth); for (let o = peekOp(); o && o[1] === 'AND'; o = peekOp()) { pos += o[0].length; v = Math.max(v, parseAtom(depth)); } return v; }
  function parseAtom(depth) {
    while (s[pos] === ' ') pos++;
    if (s[pos] === '(') { pos++; const v = parseOr(depth + 1); if (s[pos] !== ')') throw new Error('unbalanced'); pos++; return v; }
    const end = atomEnd(depth);
    const atom = s.slice(pos, end);
    pos = end;
    const r = rankAtom(atom);
    if (r === 2) sawUnread = true;
    if (r === 3 && !CONFLICT_ID.test(atom.trim()) && !CONFLICT_NAMES.has(atom.trim().replace(/\s+/g, ' ').toLowerCase())) sawUnread = true; // a recognised copyleft operand is a listed copyleft id or a listed free-text name; «GPL-3.0)» is malformed text, not a choice
    return r;
  }
  let v;
  try { v = parseOr(0); } catch (e) { return CONFLICT_RX.test(s.toLowerCase().replace(/lgpl/g, '')) ? 3 : 2; }
  if (pos < s.length) return CONFLICT_RX.test(s.toLowerCase().replace(/lgpl/g, '')) ? 3 : 2; // text left over (an unbalanced «)»)
  return sawUnread ? (CONFLICT_RX.test(s.toLowerCase().replace(/lgpl/g, '')) ? 3 : 2) : v; // unread stops the run either way; a copyleft word only makes the message say «conflict»
}

// ---- lockfile readers ----
function parsePnpmLock(text, label) {
  const lock = yaml.load(text);
  if (!lock || String(lock.lockfileVersion) !== '9.0') throw new Error(`${label}: lockfileVersion ${lock && lock.lockfileVersion} — this reader knows 9.0`);
  return lock;
}
function readPnpmLock(text, label) {
  const lock = parsePnpmLock(text, label);
  if (!lock.packages || typeof lock.packages !== 'object' || !Object.keys(lock.packages).length) throw new Error(`${label}: no packages section — an empty lockfile is refused, not read as «nothing to list»`);
  const out = [];
  for (const [key, val] of Object.entries(lock.packages)) {
    const m = /^(@?[^@]+)@(\d.*)$/.exec(key);
    if (!m) throw new Error(`${label}: package key «${key}» is not name@version from a registry — list it in MANUAL`);
    const res = (val && val.resolution) || {};
    if (typeof res.integrity !== 'string' || !/^sha(1|256|384|512)-[A-Za-z0-9+/=]{8,}$/.test(res.integrity) || Object.keys(res).some((k) => k !== 'integrity')) throw new Error(`${label}: ${key} is not a registry tarball with an integrity hash (${Object.keys(res).join(',') || 'no resolution'}) — list it in MANUAL`);
    out.push({ key: `npm:${m[1]}@${m[2]}`, name: m[1], version: m[2], eco: 'npm' });
  }
  // every dependency a workspace package declares is either another workspace package (link:) or one of the packages above — nothing is read past
  const known = new Set(out.map((e) => `${e.name}@${e.version}`));
  for (const [imp, d] of Object.entries(lock.importers || {})) {
    for (const sec of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(d[sec] || {})) {
        const v = String(spec && typeof spec === 'object' ? spec.version : spec);
        if (v.startsWith('link:')) continue;
        const k = v.startsWith('npm:') ? v.slice(4).replace(/\(.*$/, '') : `${name}@${v.replace(/\(.*$/, '')}`;
        if (!known.has(k)) throw new Error(`${label}: ${imp} depends on ${name}@${v}, which is neither a link: nor a package of the lockfile — list it in MANUAL`);
      }
    }
  }
  return out;
}

/** uv.lock: every [[package]] from a registry; the project's own package (virtual / editable source) is not a dependency; any other source (git, url, path) is refused */
function readUvLock(text, label) {
  const lock = parseToml(text);
  if (!Array.isArray(lock.package) || !lock.package.length) throw new Error(`${label}: no [[package]] entries`);
  const out = [];
  for (const p of lock.package) {
    const src = p.source || {};
    if (src.virtual === '.' || src.editable === '.') continue; // the project's own package; an editable / virtual dependency from anywhere else is refused below
    if (src.registry === undefined) throw new Error(`${label}: ${p.name} ${p.version} is not from a registry (${Object.keys(src).join(',')}) — list it in MANUAL`);
    if (!p.name || !p.version) throw new Error(`${label}: a package without name or version`);
    out.push({ key: `pypi:${p.name}@${p.version}`, name: p.name, version: p.version, eco: 'pypi' });
  }
  return out;
}

/** the packages this repository patches (pnpm patchedDependencies): name@version → the patch file, relative to the lockfile */
function readPnpmPatched(text, label = 'lockfile') {
  const lock = parsePnpmLock(text, label);
  return Object.entries(lock.patchedDependencies || {}).map(([k, v]) => ({ key: `npm:${k}`, patch: v.path })).sort((a, b) => cmp(a.key, b.key));
}

/** a digest of what a lockfile lists (its sorted package@version keys), not of its bytes: the public export rewrites comments and hashes inside some lockfiles, but not the package list */
function listDigest(entries) { return crypto.createHash('sha256').update(entries.map((e) => e.key).sort(cmp).join('\n')).digest('hex').slice(0, 12); }

// ---- registry reads (only --refresh) ----
async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'third-party-notices/1' } }); if (r.ok) return await r.json(); if (r.status === 404) throw new Error('404'); } catch (e) { if (i === 2) throw e; }
  }
  throw new Error('no answer');
}
const cleanUrl = (u) => (u || '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
async function fetchNpm(name, version) {
  const j = await getJson(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`);
  let lic = j.license;
  if (lic && typeof lic === 'object') lic = lic.type;
  if (!lic && Array.isArray(j.licenses)) lic = j.licenses.map((x) => (x && x.type) || String(x)).join(' OR ');
  const repo = cleanUrl(typeof j.repository === 'string' ? j.repository : j.repository && j.repository.url) || j.homepage || '';
  return { l: lic || '', s: repo };
}

/**
 * the licence value of a PyPI release from its `info`: license_expression, else the classifiers joined by OR, else the first line of `license`.
 * The other signals (each classifier, the first line of the free-text `license`) must not be able to hide a stricter licence: a signal that ranks higher than the chosen value (1 notice duty or 3 copyleft above a 0 / 1)
 * and is not already part of it is kept beside it, `(value) AND signal`, so the contradiction stops the run or shows in the notice table instead of being resolved in the permissive direction.
 * A classifier is always a licence name, so an unread one (rank 2) beside an expression is kept too; so is any other free-text line that is not a licence name — only a line shaped like a copyright header («Copyright …», «(c) …») says nothing and is not used.
 */
function pypiValue(info) {
  const classifiers = (info.classifiers || []).filter((c) => c.startsWith('License ::')).map((c) => c.split('::').pop().trim()).filter((c) => c && c.toLowerCase() !== 'osi approved');
  const textLine = (info.license || '').split('\n')[0].trim().slice(0, 80);
  let lic = info.license_expression || (classifiers.length ? classifiers.join(' OR ') : textLine);
  const classifiersAreTheValue = !info.license_expression && classifiers.length > 0; // then they ARE the chosen value (joined by OR), not other signals
  const signals = [...(classifiersAreTheValue ? [] : classifiers).map((c) => [c, true]), [textLine, false]];
  for (const [sig, isClassifier] of signals) {
    if (!sig || sig === lic) continue;
    const r = rank(sig);
    // a classifier is always a licence name, so an unread one (rank 2) next to an expression is kept too; so is a free-text line that is ONE token (it looks like a licence id: `EUPL-1.2`); a free-text line with spaces that is not a licence name (a copyright header) says nothing
    const looksLikeAnId = !isClassifier && !/^\s*(?:copyright\b|\(c\)|©)/i.test(sig); // inverted: ONLY a line shaped like a copyright header says nothing; any other unread text beside a permissive value stops the run
    if (((r === 1 || r === 3) || (r === 2 && (isClassifier || looksLikeAnId))) && (r === 2 ? rank(lic) < 2 : rank(lic) < r)) lic = `(${lic}) AND ${/\b(?:OR|AND|WITH)\b/.test(sig) ? `(${sig})` : sig}`; // an expression is parenthesised so its OR / AND cannot regroup with the rest
  }
  return lic || '';
}
async function fetchPypi(name, version) {
  const j = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
  const info = j.info || {};
  const urls = info.project_urls || {};
  const repo = urls.Source || urls['Source Code'] || urls.Repository || urls.Homepage || info.home_page || '';
  return { l: pypiValue(info), s: repo };
}

async function refresh(entries, cache) {
  const missing = [...new Map(entries.filter((e) => !cache[e.key]).map((e) => [e.key, e])).values()];
  let i = 0;
  const worker = async () => { for (;;) { const e = missing[i++]; if (!e) return; const v = e.eco === 'pypi' ? await fetchPypi(e.name, e.version) : await fetchNpm(e.name, e.version); cache[e.key] = rank(v.l) >= 1 ? v : { l: v.l }; } };
  await Promise.all(Array.from({ length: 12 }, worker));
  return missing.length;
}

// ---- the file ----
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function licenceOf(key, cache, overrides) {
  if (overrides[key]) return { l: overrides[key].license, s: (cache[key] && cache[key].s) || '', over: overrides[key].why };
  const c = cache[key];
  if (!c) throw new Error(`no licence value for ${key} in ${CACHE} — run: node scripts/third-party-notices.js --refresh`);
  return c;
}

function build({ locks, cache, manual = MANUAL, overrides = OVERRIDES }) {
  const seen = new Map();
  for (const { file, entries, hash } of locks) for (const e of entries) if (!seen.has(e.key)) seen.set(e.key, { ...e, from: [] }), seen.get(e.key).from.push(file);
  const rows = [];
  const problems = [];
  for (const e of seen.values()) {
    let c;
    try { c = licenceOf(e.key, cache, overrides); } catch (err) { problems.push(err.message); continue; }
    const r = rank(c.l);
    if (r === 3) problems.push(`${e.key}: «${c.l}» conflicts with a permissive release`);
    if (r === 2) problems.push(`${e.key}: «${c.l}» has not been read — add it to OVERRIDES with the reason`);
    rows.push({ name: e.name, version: e.version, license: c.l, source: c.s || '', rank: r, over: c.over || '' });
  }
  for (const m of manual) {
    const r0 = rank(m.license);
    if (r0 === 3) problems.push(`${m.key}: «${m.license}» conflicts with a permissive release`);
    if (r0 === 2 && !m.ack) problems.push(`${m.key}: «${m.license}» has not been read — give it an ack (why it is acceptable and what it obliges)`);
    rows.push({ name: m.key.replace(/^maven:/, '').replace(/@.*/, ''), version: m.key.replace(/^.*@/, ''), license: m.license, source: m.source, rank: r0 === 2 ? 1 : r0, note: m.note || '', ack: m.ack || '' });
  }
  const patched = locks.flatMap((l) => l.patched || []);
  for (const p of patched) {
    const row = rows.find((r) => `npm:${r.name}@${r.version}` === p.key);
    if (!seen.has(p.key)) problems.push(`${p.key}: patched in ${p.patch} but not locked`);
    else if (row && row.rank === 1) problems.push(`${p.key}: «${row.license}» is patched here (${p.patch}) — a modified LGPL / MPL component must offer its modified source; say so before this file is generated`);
  }
  if (problems.length) throw new Error(problems.sort().join('\n'));
  rows.sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
  const lines = [];
  lines.push('# Third-party notices', '');
  lines.push('This file is generated from the lockfiles — do not edit it by hand. Regenerate: `node scripts/third-party-notices.js`.', '');
  lines.push('Licence values are the package registries\' own declarations for each locked version (`scripts/third-party-notices.licenses.json`); where a registry value is empty or ambiguous, the licence file of the upstream project was read and the reason is given; libraries that no lockfile lists are entered by hand in the generator, with the licence name their own metadata gives. Source lockfiles:', '');
  for (const l of locks) lines.push(`- \`${l.file}\` (digest of its package list: ${listDigest(l.entries)})`);
  lines.push('', `Scope: every package the lockfiles above resolve — whether a product ships it or only the build or the tests use it — and the hand entries below. ${SCOPE_NOTE}`, '', `${rows.length} components. Conflict check: every component is available under a permissive licence or carries a notice duty; none is available only under a GPL, AGPL, SSPL, BUSL, non-commercial or proprietary licence${manual.some((m) => m.ack) ? ', except the terms acknowledged below' : ''} (the generator stops otherwise). This list names each component with its licence and version. It does not reproduce the licence texts or copyright notices of the components; take them from the source given or from the component's own package, and include them when you redistribute a component.`, '');
  const notice = rows.filter((r) => r.rank === 1);
  lines.push('## Components under licences with obligations beyond attribution', '');
  if (!notice.length) lines.push('None.', '');
  else {
    lines.push('The source of each package below is available from the location given (for the terms acknowledged by hand, the location is where the terms are published). None of them is modified in this repository (the generator stops if a patched component is under an LGPL or MPL licence). Where a component is under the LGPL, a user may replace that library with a modified version of it.', '');
    lines.push('| Component | Version | Licence | Source / terms |', '|---|---|---|---|');
    for (const r of notice) lines.push(`| ${r.name} | ${r.version} | ${r.license} | ${r.source || '—'} |`);
    lines.push('');
    for (const r of notice.filter((x) => x.note)) lines.push(`- ${r.name} ${r.version}: ${r.note}.`);
    if (notice.some((x) => x.note)) lines.push('');
  }
  const acked = rows.filter((r) => r.ack);
  if (acked.length) {
    lines.push('## Terms acknowledged by hand', '');
    lines.push('These are not open-source licences and are not in any lockfile; each is accepted for the reason given.', '');
    for (const r of acked) lines.push(`- ${r.name} ${r.version}: ${r.license} — ${r.ack}`);
    lines.push('');
  }
  const over = rows.filter((r) => r.over);
  if (over.length) {
    lines.push('## Licences read from the upstream project', '');
    lines.push('The registry gave no usable value for these; the upstream licence file was read.', '');
    for (const r of over) lines.push(`- ${r.name} ${r.version}: ${r.license} — ${r.over}`);
    lines.push('');
  }
  if (patched.length) {
    lines.push('## Components patched in this repository', '');
    lines.push('These components are modified here by a patch file, applied at install time; none of them is under a copyleft licence.', '');
    for (const p of patched) { const r = rows.find((x) => `npm:${x.name}@${x.version}` === p.key); lines.push(`- ${r.name} ${r.version} (${r.license}): \`${p.patch}\``); }
    lines.push('');
  }
  lines.push('## All components, by licence', '');
  const byLic = new Map();
  for (const r of rows) { if (!byLic.has(r.license)) byLic.set(r.license, []); byLic.get(r.license).push(r); }
  for (const lic of [...byLic.keys()].sort((a, b) => byLic.get(b).length - byLic.get(a).length || cmp(a, b))) {
    const list = byLic.get(lic);
    lines.push(`### ${lic} (${list.length})`, '');
    for (const r of list) lines.push(`- ${r.name} ${r.version}`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function gatherRaw() {
  return [
    ...LOCKS.map((file) => ({ file, entries: readPnpmLock(fs.readFileSync(path.join(ROOT, file), 'utf8'), file), patched: readPnpmPatched(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).map((p) => ({ key: p.key, patch: path.posix.join(path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file), p.patch) })) })),
    ...UV_LOCKS.map((file) => ({ file, entries: readUvLock(fs.readFileSync(path.join(ROOT, file), 'utf8'), file) })),
  ];
}
function gather() {
  const locks = gatherRaw();
  for (const l of locks) for (const p of l.patched || []) if (!fs.existsSync(path.join(ROOT, p.patch))) throw new Error(`${p.key}: its patch file ${p.patch} does not exist`);
  return locks;
}
function loadCache() { const p = path.join(ROOT, CACHE); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}; }
function writeCache(cache, keep) {
  const sorted = {};
  for (const k of Object.keys(cache).sort(cmp)) if (keep.has(k)) sorted[k] = cache[k];
  fs.writeFileSync(path.join(ROOT, CACHE), JSON.stringify(sorted, null, 1) + '\n');
}

async function main(argv) {
  const mode = argv[0] || '';
  const locks = gather();
  const cache = loadCache();
  const all = locks.flatMap((l) => l.entries);
  if (mode === '--refresh') {
    const n = await refresh(all, cache);
    const keep = new Set(all.map((e) => e.key));
    writeCache(cache, keep);
    console.log(`licence cache: ${n} read from the registries, ${Object.keys(cache).filter((k) => keep.has(k)).length} kept`);
  }
  const text = build({ locks, cache });
  if (mode === '--check') {
    const cur = fs.existsSync(path.join(ROOT, OUT)) ? fs.readFileSync(path.join(ROOT, OUT), 'utf8') : '';
    if (cur !== text) { console.error(`${OUT} is not what the lockfiles and the licence cache give — run: node scripts/third-party-notices.js`); return 1; }
    console.log(`${OUT} is current`);
    return 0;
  }
  fs.writeFileSync(path.join(ROOT, OUT), text);
  console.log(`${OUT}: ${text.split('\n').length} lines`);
  return 0;
}

module.exports = { listDigest, rank, rankAtom, pypiValue, readPnpmLock, readPnpmPatched, readUvLock, gather, build, LOCKS, UV_LOCKS, MANUAL, OVERRIDES, OUT, CACHE, ROOT };
if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
