// @vitest-environment jsdom
/** story 5036 (C6 · the first-run line in the Mac app): the mark of the project step ① made — the tab's own, a few hours long, never trusted past its shape. */
import { afterEach, describe, expect, it } from 'vitest';
import { clearLineProject, readLineProject, writeLineProject } from './line-project';

afterEach(() => { sessionStorage.clear(); });

describe('the first-run line\'s project mark', () => {
  it('written and read back (the organization and the project)', () => {
    writeLineProject({ orgId: 'o-1', projectId: 'p-1' }, 1_000);
    expect(readLineProject(2_000)).toEqual({ orgId: 'o-1', projectId: 'p-1' });
  });

  it('nothing written → null; cleared → null', () => {
    expect(readLineProject()).toBeNull();
    writeLineProject({ orgId: 'o-1', projectId: 'p-1' });
    clearLineProject();
    expect(readLineProject()).toBeNull();
  });

  it('a mark older than an hour is a leftover — not used (and one from the future is not believed)', () => {
    writeLineProject({ orgId: 'o-1', projectId: 'p-1' }, 10_000);
    expect(readLineProject(10_000 + 60 * 60 * 1000)).not.toBeNull();
    expect(readLineProject(10_000 + 60 * 60 * 1000 + 1)).toBeNull();
    expect(readLineProject(9_000)).toBeNull();
  });

  it.each([
    ['not JSON', '{nope'],
    ['not an object', '"x"'],
    ['no project', JSON.stringify({ orgId: 'o-1', at: 1 })],
    ['an empty project', JSON.stringify({ orgId: 'o-1', projectId: '', at: 1 })],
    ['no organization', JSON.stringify({ projectId: 'p-1', at: 1 })],
    ['no time', JSON.stringify({ orgId: 'o-1', projectId: 'p-1' })],
  ])('a stored value that is %s is no mark', (_n, raw) => {
    sessionStorage.setItem('sprintable:onboarding-line-project', raw);
    expect(readLineProject(2)).toBeNull();
  });

  it('a storage that refuses is no mark and no throw', () => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    try { expect(readLineProject()).toBeNull(); } finally { Storage.prototype.getItem = real; }
  });
});
