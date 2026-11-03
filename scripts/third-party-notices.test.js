// [SID:4836] scripts/third-party-notices.js — THIRD_PARTY_NOTICES.md is what the lockfiles and the licence cache give (nothing in it is written by hand),
// and no locked dependency conflicts with a permissive release.
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { listDigest, rank, pypiValue, readPnpmLock, readPnpmPatched, readUvLock, gather, build, LOCKS, UV_LOCKS, MANUAL, OVERRIDES, OUT, CACHE, ROOT } from './third-party-notices.js';

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('rank — 0 permissive · 1 notice duty · 2 nobody has read it · 3 conflict', () => {
  const RANKS = [
    ['MIT WITH non-commercial restriction', 3], ['Apache-2.0 WITH Commons-Clause', 2], ['MIT OR (GNU General Public License v3 (GPLv3)', 3], ['MIT OR GNU General Public License v3 (GPLv3)', 0], ['MIT OR GNU Foo Public License', 2], ['MIT OR GNU General Public License v3 (GPLv3))', 3], ['PSF', 0], ['(Python Software Foundation License) AND PSF', 0], ['MIT OR Proprietary', 3], ['MPL-2.0 OR non-commercial', 3], ['MIT OR SSPL-2.0', 3], ['MIT OR BUSL-1.2', 3], ['MIT OR GPL-bogus', 3], ['MPL-2.0 OR GPL-bogus', 3], ['MIT OR GPL', 3], ['MIT OR GPL-3.1', 3], ['MIT OR AGPL-2.0', 3], ['MIT OR CC-BY-NC-4.0', 0], ['MIT OR BUSL-1.1', 0], ['MIT OR AGPL-3.0', 0], ['MIT OR SSPL-1.0', 0], ['MIT OR GPL-2.0-only', 0], ['MIT OR GPL-3.0+', 0], ['MIT OR Foo-1.0', 2], ['MIT OR UNLICENSED', 3], ['MIT OR GPL-3.0)', 3], ['(MIT OR GPL-3.0', 3], ['MIT OR (GPL-3.0', 3], ['MIT OR GNU General Public License v3 (GPLv3)', 0], ['MIT OR Foo', 2], ['MIT OR LGPLv3', 2], ['MIT OR Apache-2.0 WITH Commons-Clause', 2], ['MIT OR Apache-2.0)', 2], ['(MIT AND Foo)', 2], ['DFSG approved OR MIT License', 2], ['MIT OR GPL-3.0', 0], ['(MIT OR GPL-3.0-or-later)', 0], ['(MIT', 2], ['MIT)', 2], ['MPL-2.0 non commercial', 3], ['LGPL-2.1-with-linking-exception', 2], ['LGPLv3', 2], ['MIT WITH Commons-Clause', 2], ['((MIT)', 2], ['MIT OR', 2], [' OR MIT', 2], ['MIT or GPL-3.0', 3], ['MIT and GPL-3.0', 3], ['MIT / GPL-3.0', 3], ['MIT*', 2], ['MIT style', 2], ['MIT-CMU', 0], ['LGPL-3.0 or GPL-3.0', 3], ['MIT or Apache-2.0', 2], ['GPL', 3], ['Dual License', 2], ['mit', 0], ['MIT', 0], ['(MIT OR GPL-3.0-or-later)', 0], ['Apache-2.0 AND LGPL-3.0-or-later', 1], ['LGPL-3.0-or-later', 1], ['GPL-3.0', 3], ['GPL-2.0-only', 3], ['BSD-3-Clause', 0], ['MPL-2.0', 1],
    ['(MPL-2.0 OR Apache-2.0)', 0], ['Python-2.0', 0], ['UNLICENSED', 3], ['CC-BY-4.0', 0], ['Apache 2.0', 0], ['BSD', 0], ['(BSD-2-Clause OR MIT OR Apache-2.0)', 0], ['AGPL-3.0', 3], ['ISC', 0],
    ['Apache-2.0 WITH LLVM-exception', 0], ['GPL-2.0-only WITH Classpath-exception-2.0', 3], ['GPL-3.0-or-later WITH GCC-exception-3.1', 3], ['GPL-2.0-with-classpath-exception', 3], ['OFL-1.1', 1], ['SEE LICENSE IN LICENSE.md', 2], ['Proprietary', 3], ['LGPL with exceptions', 2], ['Apache Software License', 0],
    ['MIT License', 0], ['BSD License', 0], [null, 2], ['', 2], ['(MIT AND Zlib)', 0], ['(Apache-2.0 OR MPL-2.0)', 0], ['CC0-1.0', 0], ['BlueOak-1.0.0', 0], ['Unlicense', 0], ['(MIT OR CC0-1.0)', 0], ['PSF-2.0', 0],
    ['Mozilla Public License 2.0 (MPL 2.0)', 1], ['GNU Lesser General Public License v3 or later (LGPLv3+)', 1], ['GNU General Public License v3 (GPLv3)', 3],
    ['Apache Software License OR BSD License', 0],  ['GNU Library or Lesser General Public License (LGPL)', 1], ['3-Clause BSD License', 0],
    ['SSPL-1.0', 3], ['BUSL-1.1', 3], ['CC-BY-NC-4.0', 3], ['Elastic-2.0', 3], ['(GPL-3.0 AND MIT)', 3], ['(MIT OR (GPL-2.0 AND Apache-2.0))', 0],
    ['simple', 2], ['repl-tools', 2],
  ];
  for (const [s, r] of RANKS) it(`rank(${JSON.stringify(s)}) = ${r}`, () => expect(rank(s)).toBe(r));
});

describe('lockfile readers', () => {
  const LOCK = (pk, v = '9.0') => `lockfileVersion: '${v}'\n\npackages:\n${pk}\nsnapshots:\n  x@1.0.0: {}\n`;
  const PK = "  '@scope/pkg@2.3.4':\n    resolution: {integrity: sha512-aaaaaaaaaaaa}\n  plain@1.0.0:\n    resolution: {integrity: sha512-bbbbbbbbbbbb}\n";
  it('pnpm: scoped and plain names, versions', () => expect(readPnpmLock(LOCK(PK), 'f').map((e) => e.key)).toEqual(['npm:@scope/pkg@2.3.4', 'npm:plain@1.0.0']));
  it('pnpm: another lockfile version is refused, not guessed', () => expect(() => readPnpmLock(LOCK(PK, '8.0'), 'f')).toThrow(/lockfileVersion/));
  it('pnpm: a tarball-URL package is refused', () => expect(() => readPnpmLock(LOCK('  foo@https://example.test/x.tgz:\n    resolution: {tarball: https://example.test/x.tgz}\n'), 'f')).toThrow(/not name@version/));
  it('pnpm: a non-registry resolution is refused', () => expect(() => readPnpmLock(LOCK('  foo@1.0.0:\n    resolution: {tarball: https://example.test/x.tgz}\n'), 'f')).toThrow(/not a registry tarball/));
  const UV = (extra) => `version = 1\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { virtual = "." }\n\n[[package]]\nname = "httpx"\nversion = "0.28.1"\nsource = { registry = "https://pypi.org/simple" }\n${extra}`;
  it('uv: registry packages, not the project itself', () => expect(readUvLock(UV(''), 'f').map((e) => e.key)).toEqual(['pypi:httpx@0.28.1']));
  it('uv: an editable project is not a dependency either', () => expect(readUvLock(UV('').replace('virtual = "."', 'editable = "."'), 'f').map((e) => e.key)).toEqual(['pypi:httpx@0.28.1']));
  it('uv: a git source is refused', () => expect(() => readUvLock(UV('\n[[package]]\nname = "g"\nversion = "1"\nsource = { git = "https://example.test/g" }\n'), 'f')).toThrow(/not from a registry/));
  it('uv: no packages is refused', () => expect(() => readUvLock('version = 1\n', 'f')).toThrow(/no \[\[package\]\]/));
});

describe('pypiValue — the value a PyPI release is ranked by', () => {
  const cl = (...c) => c.map((x) => `License :: OSI Approved :: ${x}`);
  it('license_expression first', () => expect(pypiValue({ license_expression: 'Apache-2.0', classifiers: cl('MIT License'), license: 'Copyright (c) 2020 Some Author' })).toBe('Apache-2.0'));
  it('classifiers joined by OR when there is no expression', () => expect(pypiValue({ classifiers: cl('Apache Software License', 'BSD License') })).toBe('Apache Software License OR BSD License'));
  it('the first line of the licence text when there is nothing else', () => expect(pypiValue({ license: 'MIT License\n\nPermission is hereby granted…' })).toBe('MIT License'));
  it('a licence text that agrees with the classifiers changes nothing', () => expect(pypiValue({ classifiers: cl('MIT License'), license: 'MIT License' })).toBe('MIT License'));
  it('a licence text that names a copyleft licence the classifiers do not is kept beside them, so the run stops', () => {
    const v = pypiValue({ classifiers: cl('MIT License'), license: 'GNU General Public License v3' });
    expect(v).toBe('(MIT License) AND GNU General Public License v3');
    expect(rank(v)).toBe(3);
  });
  it('and so does a weak-copyleft text (it becomes a notice duty, visible in the table)', () => expect(rank(pypiValue({ license_expression: 'MIT', license: 'LGPL-3.0-or-later' }))).toBe(1));
  it('an OR-valued choice is parenthesised before a contradicting text is appended, so the OR cannot absorb it', () => {
    const v = pypiValue({ license_expression: 'MIT OR GPL-3.0', license: 'GPL-3.0' });
    expect(v).toBe('(MIT OR GPL-3.0) AND GPL-3.0');
    expect(rank(v)).toBe(3);
    const w = pypiValue({ classifiers: cl('MIT License', 'GNU General Public License v3 (GPLv3)'), license: 'GPL-3.0' });
    expect(rank(w)).toBe(3);
  });
  it('a copyright-header line says nothing and is not used', () => expect(pypiValue({ classifiers: cl('MIT License'), license: 'Copyright (c) 2020 Some Author' })).toBe('MIT License'));
  it('a notice-duty expression with a copyleft text line still stops', () => expect(rank(pypiValue({ license_expression: 'LGPL-3.0-or-later', license: 'GPL-3.0' }))).toBe(3));
  it('a permissive expression with a copyleft classifier stops', () => {
    const v = pypiValue({ license_expression: 'MIT', classifiers: cl('MIT License', 'GNU General Public License v3 (GPLv3)') });
    expect(v).toBe('(MIT) AND GNU General Public License v3 (GPLv3)');
    expect(rank(v)).toBe(3);
  });
  it('a copyleft classifier that is part of the chosen value is a choice, not a contradiction', () => expect(rank(pypiValue({ classifiers: cl('MIT License', 'GNU General Public License v3 (GPLv3)') }))).toBe(0));
  it('a permissive expression with an unread classifier stops (a classifier is always a licence name)', () => {
    const v = pypiValue({ license_expression: 'MIT', classifiers: cl('MIT License', 'Foo License') });
    expect(v).toBe('(MIT) AND Foo License');
    expect(rank(v)).toBe(2);
  });
  it('a one-token text line that looks like a licence id but is not listed stops (EUPL-1.2, Foo-1.0)', () => {
    expect(rank(pypiValue({ license_expression: 'MIT', license: 'EUPL-1.2' }))).toBe(2);
    expect(pypiValue({ license_expression: 'MIT', license: 'EUPL-1.2' })).toBe('(MIT) AND EUPL-1.2');
  });
  it('a text line that is an expression with an unread operand stops (MIT OR Foo-1.0)', () => {
    expect(pypiValue({ license_expression: 'MIT', license: 'MIT OR Foo-1.0' })).toBe('(MIT) AND (MIT OR Foo-1.0)');
    expect(rank(pypiValue({ license_expression: 'MIT', license: 'MIT OR Foo-1.0' }))).toBe(2);
  });
  it('a copyright-header line does not stop a permissive expression', () => {
    expect(rank(pypiValue({ license_expression: 'MIT', license: 'Copyright (c) 2020 Foo Bar' }))).toBe(0);
    expect(rank(pypiValue({ license_expression: 'MIT', license: '(c) 2020 Foo' }))).toBe(0);
  });
  it('any other unread free text beside a permissive value stops (a licence family name, a sentence)', () => {
    for (const text of ['GNU Lesser General Public License v2.1', 'Eclipse Public License 2.0', 'See the LICENSE file', 'Foo Bar']) expect(rank(pypiValue({ license_expression: 'MIT', license: text }))).toBe(2);
    expect(rank(pypiValue({ license_expression: 'MIT', license: 'Eclipse Public License 2.0' }))).toBe(2);
  });
  it('a permissive expression with a weak-copyleft classifier shows in the notice table', () => expect(rank(pypiValue({ license_expression: 'MIT', classifiers: cl('GNU Lesser General Public License v3 or later (LGPLv3+)') }))).toBe(1));
  it('nothing at all is an empty value, which stops the run', () => expect(rank(pypiValue({}))).toBe(2));
});

describe('uv.lock: only the project itself is skipped', () => {
  const UV = (src) => `version = 1\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { ${src} }\n\n[[package]]\nname = "httpx"\nversion = "0.28.1"\nsource = { registry = "https://pypi.org/simple" }\n`;
  it('virtual = "." and editable = "." are the project', () => { expect(readUvLock(UV('virtual = "."'), 'f').length).toBe(1); expect(readUvLock(UV('editable = "."'), 'f').length).toBe(1); });
  it('an editable or virtual package from anywhere else is refused', () => { expect(() => readUvLock(UV('editable = "../other"'), 'f')).toThrow(/not from a registry/); expect(() => readUvLock(UV('virtual = "sub"'), 'f')).toThrow(/not from a registry/); });
});

describe('fail-closed readers', () => {
  it('pnpm: a lockfile without packages is refused', () => expect(() => readPnpmLock("lockfileVersion: '9.0'\nimporters:\n  .: {}\n", 'f')).toThrow(/no packages section/));
  it('pnpm: an empty resolution is refused', () => expect(() => readPnpmLock("lockfileVersion: '9.0'\npackages:\n  foo@1.0.0:\n    resolution: {}\n", 'f')).toThrow(/not a registry tarball/));
});

describe('fail-closed readers (more)', () => {
  it('pnpm: an empty integrity is refused', () => expect(() => readPnpmLock("lockfileVersion: '9.0'\npackages:\n  foo@1.0.0:\n    resolution: {integrity: ''}\n", 'f')).toThrow(/integrity hash/));
  it('pnpm: a bogus integrity is refused', () => expect(() => readPnpmLock("lockfileVersion: '9.0'\npackages:\n  foo@1.0.0:\n    resolution: {integrity: bogus}\n", 'f')).toThrow(/integrity hash/));
  it('pnpm: a dependency that is not among the packages is refused, not skipped', () => expect(() => readPnpmLock("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      ghost:\n        specifier: ^1\n        version: 1.0.0\npackages:\n  plain@1.0.0:\n    resolution: {integrity: sha512-bbbbbbbbbbbb}\n", 'f')).toThrow(/ghost@1\.0\.0, which is neither a link: nor a package/));
  it('pnpm: a workspace link: is our own package; a peer suffix is stripped', () => expect(readPnpmLock("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      mine:\n        specifier: workspace:*\n        version: link:../mine\n      plain:\n        specifier: ^1\n        version: 1.0.0(react@19.0.0)\npackages:\n  plain@1.0.0:\n    resolution: {integrity: sha512-bbbbbbbbbbbb}\n", 'f').map((e) => e.key)).toEqual(['npm:plain@1.0.0']));
  it('the patched reader refuses another lockfile version too', () => expect(() => readPnpmPatched("lockfileVersion: '8.0'\npatchedDependencies: {}\n", 'f')).toThrow(/lockfileVersion/));
  it('the file states its scope and what it leaves out', () => {
    const t0 = build({ locks: [{ file: 'a', hash: '0123456789ab', entries: [{ key: 'npm:aaa@1.0.0', name: 'aaa', version: '1.0.0', eco: 'npm' }, { key: 'npm:bbb@2.0.0', name: 'bbb', version: '2.0.0', eco: 'npm' }] }], cache: { 'npm:aaa@1.0.0': { l: 'MIT' }, 'npm:bbb@2.0.0': { l: 'LGPL-3.0-or-later', s: 'https://example.test/bbb' } }, manual: [] });
    expect(t0).toContain('Scope: every package the lockfiles above resolve');
    expect(t0).toContain('Operating-system packages inside the container images');
    expect(t0).toContain('None of them is modified in this repository');
  });
});

describe('manual entries pass the same gate', () => {
  const fx = [{ file: 'a/pnpm-lock.yaml', hash: '0123456789ab', entries: [{ key: 'npm:aaa@1.0.0', name: 'aaa', version: '1.0.0', eco: 'npm' }] }];
  const C = { 'npm:aaa@1.0.0': { l: 'MIT' } };
  const m = (extra) => [{ key: 'maven:g:a@1', license: 'MIT', source: 'https://example.test', ...extra }];
  it('a permissive manual entry is listed', () => expect(build({ locks: fx, cache: C, manual: m({}) })).toContain('- g:a 1'));
  it('a manual GPL entry stops the run', () => expect(() => build({ locks: fx, cache: C, manual: m({ license: 'GPL-3.0' }) })).toThrow(/conflicts with a permissive release/));
  it('a manual entry nobody has read stops the run', () => expect(() => build({ locks: fx, cache: C, manual: m({ license: 'Some Terms' }) })).toThrow(/has not been read/));
  it('an acknowledgement cannot lift a conflict', () => expect(() => build({ locks: fx, cache: C, manual: m({ license: 'GPL-3.0', ack: 'we like it' }) })).toThrow(/conflicts with a permissive release/));
  it('an acknowledged manual entry is in the notice table with its note and acknowledgement', () => {
    const t = build({ locks: fx, cache: C, manual: m({ license: 'Some Terms', ack: 'build-time only', note: 'fetched at build' }) });
    expect(t).toContain('| g:a | 1 | Some Terms |');
    expect(t).toContain('- g:a 1: fetched at build.');
    expect(t).toContain('Some Terms — build-time only');
  });
});

describe('the file from fixtures', () => {
  const fx = (keys) => [{ file: 'a/pnpm-lock.yaml', hash: '0123456789ab', entries: keys.map((k) => ({ key: `npm:${k}`, name: k.replace(/@[^@]*$/, ''), version: k.replace(/^.*@/, ''), eco: 'npm' })) }];
  const CACHE_FX = { 'npm:aaa@1.0.0': { l: 'MIT' }, 'npm:bbb@2.0.0': { l: 'LGPL-3.0-or-later', s: 'https://example.test/bbb' }, 'npm:ccc@3.0.0': { l: 'MIT' } };
  const out = build({ locks: fx(['ccc@3.0.0', 'aaa@1.0.0', 'bbb@2.0.0']), cache: CACHE_FX, manual: [], overrides: {} });
  it('the order of the lockfile does not change a byte', () => expect(out).toBe(build({ locks: fx(['aaa@1.0.0', 'bbb@2.0.0', 'ccc@3.0.0']), cache: CACHE_FX, manual: [], overrides: {} })));
  it('names the lockfile and the digest of its package list', () => expect(out).toContain('- `a/pnpm-lock.yaml` (digest of its package list: ' + listDigest(fx(['aaa@1.0.0', 'bbb@2.0.0', 'ccc@3.0.0'])[0].entries) + ')'));
  it('the digest is of the package list: order does not matter, a version does', () => {
    expect(listDigest(fx(['b@1', 'a@1'])[0].entries)).toBe(listDigest(fx(['a@1', 'b@1'])[0].entries));
    expect(listDigest(fx(['a@1'])[0].entries)).not.toBe(listDigest(fx(['a@2'])[0].entries));
  });
  it('a notice-duty component is in the table with its source', () => expect(out).toContain('| bbb | 2.0.0 | LGPL-3.0-or-later | https://example.test/bbb |'));
  it('the others are listed by licence, sorted', () => expect(out).toContain('### MIT (2)\n\n- aaa 1.0.0\n- ccc 3.0.0\n'));
  it('no clock in the file', () => expect(/\d{4}-\d{2}-\d{2}/.test(out)).toBe(false));
  it('a locked package that the cache lacks stops the run and says what to do', () => expect(() => build({ locks: fx(['aaa@1.0.0', 'zzz@9.9.9']), cache: CACHE_FX, manual: [] })).toThrow(/no licence value for npm:zzz@9\.9\.9[\s\S]*--refresh/));
  it('a conflict stops the run', () => expect(() => build({ locks: fx(['aaa@1.0.0']), cache: { 'npm:aaa@1.0.0': { l: 'GPL-3.0-only' } }, manual: [] })).toThrow(/conflicts with a permissive release/));
  it('AGPL too', () => expect(() => build({ locks: fx(['aaa@1.0.0']), cache: { 'npm:aaa@1.0.0': { l: 'AGPL-3.0' } }, manual: [] })).toThrow(/conflicts with a permissive release/));
  it('an empty value stops the run until someone has read the upstream licence', () => expect(() => build({ locks: fx(['aaa@1.0.0']), cache: { 'npm:aaa@1.0.0': { l: '' } }, manual: [] })).toThrow(/has not been read/));
  it('an override resolves an empty value and is named in the file', () => {
    const o = { 'npm:aaa@1.0.0': { license: 'MIT', why: 'upstream licence file read' } };
    const t = build({ locks: fx(['aaa@1.0.0']), cache: { 'npm:aaa@1.0.0': { l: '' } }, manual: [], overrides: o });
    expect(t).toContain('- aaa 1.0.0: MIT — upstream licence file read');
    expect(t).toContain('### MIT (1)');
  });
  it('an unknown value too', () => expect(() => build({ locks: fx(['aaa@1.0.0']), cache: { 'npm:aaa@1.0.0': { l: 'Some Custom Terms' } }, manual: [] })).toThrow(/has not been read/));
});

describe('provenance sections', () => {
  const fx = [{ file: 'a/pnpm-lock.yaml', hash: '0123456789ab', entries: [{ key: 'npm:aaa@1.0.0', name: 'aaa', version: '1.0.0', eco: 'npm' }] }];
  const C = { 'npm:aaa@1.0.0': { l: 'MIT' } };
  it('a hand-acknowledged term is not presented as a licence read from the upstream project', () => {
    const t = build({ locks: fx, cache: C, manual: [{ key: 'maven:g:a@1', license: 'Some Terms', ack: 'build-time only', source: 'https://example.test' }] });
    expect(t).toContain('## Terms acknowledged by hand');
    expect(t).toContain('- g:a 1: Some Terms — build-time only');
    expect(t).not.toContain('## Licences read from the upstream project');
    expect(t).toContain('except the terms acknowledged below');
  });
  it('the conflict sentence has no exception when there is none', () => expect(build({ locks: fx, cache: C, manual: [] })).not.toContain('except the terms acknowledged'));
});

describe('patched components', () => {
  const fx = (keys, patched) => [{ file: 'a/pnpm-lock.yaml', hash: '0123456789ab', patched, entries: keys.map((k) => ({ key: `npm:${k}`, name: k.replace(/@[^@]*$/, ''), version: k.replace(/^.*@/, ''), eco: 'npm' })) }];
  const C = { 'npm:aaa@1.0.0': { l: 'MIT' }, 'npm:bbb@2.0.0': { l: 'LGPL-3.0-or-later', s: 'https://example.test/bbb' } };
  it('reads the patched packages of a lockfile', () => expect(readPnpmPatched("lockfileVersion: '9.0'\npatchedDependencies:\n  '@x/y@1.0.0':\n    hash: abc\n    path: patches/y.patch\n")).toEqual([{ key: 'npm:@x/y@1.0.0', patch: 'patches/y.patch' }]));
  it('none', () => expect(readPnpmPatched("lockfileVersion: '9.0'\n")).toEqual([]));
  it('a patched component is named with its patch file', () => {
    const t = build({ locks: fx(['aaa@1.0.0', 'bbb@2.0.0'], [{ key: 'npm:aaa@1.0.0', patch: 'a/patches/aaa.patch' }]), cache: C, manual: [] });
    expect(t).toContain('## Components patched in this repository');
    expect(t).toContain('- aaa 1.0.0 (MIT): `a/patches/aaa.patch`');
  });
  it('no patches, no section', () => expect(build({ locks: fx(['aaa@1.0.0'], []), cache: C, manual: [] })).not.toContain('patched in this repository'));
  it('a patched LGPL / MPL component stops the run', () => expect(() => build({ locks: fx(['aaa@1.0.0', 'bbb@2.0.0'], [{ key: 'npm:bbb@2.0.0', patch: 'a/patches/bbb.patch' }]), cache: C, manual: [] })).toThrow(/is patched here/));
  it('a patch for a package that is not locked is a stale patch', () => expect(() => build({ locks: fx(['aaa@1.0.0'], [{ key: 'npm:nope@1.0.0', patch: 'a/patches/n.patch' }]), cache: C, manual: [] })).toThrow(/patched in a\/patches\/n\.patch but not locked/));
});

describe('the repository itself', () => {
  const ls = (pattern) => cp.execFileSync('git', ['-C', ROOT, 'ls-files', '--', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean);
  it('every pnpm lockfile is read (a new one fails here until it is listed)', () => expect(ls('*pnpm-lock.yaml').sort()).toEqual([...LOCKS].sort()));
  it('every uv lockfile is read (a new one fails here until it is listed)', () => expect(ls('*uv.lock').sort()).toEqual([...UV_LOCKS].sort()));
  const locks = gather();
  const cache = JSON.parse(read(CACHE));
  const used = new Set(locks.flatMap((l) => l.entries.map((e) => e.key)));
  it('the licence cache holds nothing that is no longer locked', () => expect(Object.keys(cache).filter((k) => !used.has(k))).toEqual([]));
  it('every locked package has a licence value', () => expect([...used].filter((k) => !cache[k] && !OVERRIDES[k])).toEqual([]));
  it('every patch file exists', () => { for (const p of locks.flatMap((l) => l.patched || [])) expect(fs.existsSync(path.join(ROOT, p.patch))).toBe(true); });
  const GOLD = {"(Apache Software License) AND Apache License 2.0": 0, "(Apache Software License) AND Apache License, Version 2.0": 0, "(MIT AND Zlib)": 0, "(MIT OR CC0-1.0)": 0, "(MIT OR GPL-3.0-or-later)": 0, "(MPL-2.0 OR Apache-2.0)": 0, "0BSD": 0, "3-Clause BSD License": 0, "Apache Software License": 0, "Apache Software License OR BSD License": 0, "Apache Software License OR MIT License": 0, "Apache-2.0": 0, "Apache-2.0 AND LGPL-3.0-or-later": 1, "Apache-2.0 AND LGPL-3.0-or-later AND MIT": 1, "Apache-2.0 AND MIT": 0, "Apache-2.0 OR BSD-2-Clause": 0, "Apache-2.0 OR BSD-3-Clause": 0, "BSD": 0, "BSD License": 0, "BSD-2-Clause": 0, "BSD-3-Clause": 0, "BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0": 0, "BlueOak-1.0.0": 0, "CC-BY-4.0": 0, "CC0-1.0": 0, "GNU Library or Lesser General Public License (LGPL)": 1, "ISC": 0, "LGPL-3.0-or-later": 1, "MIT": 0, "MIT AND PSF-2.0": 0, "MIT License": 0, "MIT-0": 0, "MIT-CMU": 0, "MPL-2.0": 1, "Mozilla Public License 2.0 (MPL 2.0)": 1, "PSF-2.0": 0, "Python Software Foundation License": 0, "Python-2.0": 0, "Unlicense": 0};
  it('the licence values in the cache are exactly the ones listed (a new value must be read and listed)', () => {
    const vals = {};
    for (const [k, v] of Object.entries(cache)) vals[OVERRIDES[k] ? OVERRIDES[k].license : v.l] = true;
    expect(Object.keys(vals).sort()).toEqual(Object.keys(GOLD).sort());
  });
  for (const [l, r] of Object.entries(GOLD)) it(`GOLD ${l} = ${r}`, () => expect(rank(l)).toBe(r));
  it('the cache is sorted', () => expect(Object.keys(cache)).toEqual(Object.keys(cache).sort()));
  it('the digest of every lockfile\'s package list is the one in the file', () => {
    const text = read(OUT);
    for (const l of locks) expect(text).toContain(`- \`${l.file}\` (digest of its package list: ${listDigest(l.entries)})`);
  });
  it('THIRD_PARTY_NOTICES.md is what the lockfiles and the cache give — regenerate with node scripts/third-party-notices.js', () => expect(build({ locks, cache })).toBe(read(OUT)));
  it('the weak-copyleft components are in the file with a source', () => {
    const text = read(OUT);
    for (const name of ['psycopg2-binary', 'certifi', '@img/sharp-libvips-linux-x64', 'lightningcss']) expect(text).toMatch(new RegExp(`\\| ${name.replace('/', '\\/')} \\| [^|]+ \\| [^|]+ \\| https://`));
  });
  it('every override has a reason', () => { for (const [k, v] of Object.entries(OVERRIDES)) expect(`${k}: ${v.why}`.length).toBeGreaterThan(k.length + 30); });
  it('no manual entries here (no Gradle or other unlisted libraries)', () => expect(MANUAL).toEqual([]));
});
